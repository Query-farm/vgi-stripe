/**
 * One factory for every Stripe list endpoint.
 *
 * A spec names the columns (with a JSON extractor each), which SQL columns map onto
 * list parameters, time ranges and Search fields, and optional per-parent fan-out.
 * The factory turns that into a VGI table function that:
 *
 * - streams one Stripe page (up to 100 objects) per Arrow batch;
 * - keeps its cursor (`phase` + `starting_after` id or Search `next_page` token) in
 *   serializable state, so a scan resumes on any process over HTTP;
 * - reads the `stripe` secret on every call and never stores it in state;
 * - pushes filters down (narrowing only) and lets the SDK re-apply them exactly;
 * - switches to the Search API only when a filter can be expressed there but not as a
 *   list parameter (Search is eventually consistent, the list API is not);
 * - adds `expand[]=data.<field>` only when a column that needs the expanded object is
 *   projected, plus any raw `expand :=` paths the caller asks for.
 */

import {
  batchFromColumns,
  bool,
  decimal128,
  defineTableFunction,
  field,
  float64,
  formatPushedFilters,
  int64,
  list,
  map,
  schema,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import { type Category, column, objectTags } from "../meta.ts";
import { configFromSecrets, type QueryValue, type StripeConfig, stripeGet } from "./client.ts";
import { AMOUNT_SCALE, minorStringToDecimal, minorToDecimal, UNIT_SCALE } from "./money.ts";
import {
  boolValue,
  type Constraint,
  combineSearch,
  constraintsOf,
  eqValues,
  type SearchField,
  searchClauses,
  secondsRange,
} from "./pushdown.ts";

// ------------------------------------------------------------------ column helpers

// biome-ignore lint/suspicious/noExplicitAny: Stripe JSON is untyped.
export type Row = Record<string, any> & { __ctx?: Record<string, string> };

export interface Col {
  name: string;
  type: VgiDataType;
  /** DuckDB spelling for vgi.result_columns_schema. */
  sqlType: string;
  doc: string;
  nullable: boolean;
  get: (row: Row) => unknown;
  /** The expansion (`expand[]=data.<field>`) this column needs, if any. */
  expands?: string;
}

/** Walk a dotted path through untyped JSON. */
export function at(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** The id of an expandable field: the string itself, or the expanded object's id. */
export function idOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") return (v as { id: string }).id;
  return null;
}

export const asStr = (v: unknown): string | null =>
  v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
export const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
export const asBigint = (v: unknown): bigint | null =>
  typeof v === "number" && Number.isInteger(v) ? BigInt(v) : typeof v === "bigint" ? v : null;
export const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Unix seconds → TIMESTAMPTZ microseconds. */
export const asTime = (v: unknown): bigint | null =>
  typeof v === "number" && Number.isFinite(v) ? BigInt(Math.trunc(v)) * 1_000_000n : null;
export const asStrList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x) => x != null).map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : null;
/** Stripe metadata (string → string) as a MAP value. */
export const asMeta = (v: unknown): Record<string, string> | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, asStr(x) ?? ""]));
};

/** Keys whose values are credentials and never leave the worker (`raw` column included). */
const SECRET_KEYS = new Set(["client_secret", "secret"]);

/** Deep-copy a Stripe object with credential fields replaced by "[redacted]". */
export function redactSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactSecrets);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "__ctx") continue;
      out[k] = SECRET_KEYS.has(k) && x != null ? "[redacted]" : redactSecrets(x);
    }
    return out;
  }
  return v;
}

const JSON_META: [string, string] = ["ARROW:extension:name", "arrow.json"];
const AMOUNT_TYPE = decimal128(38, AMOUNT_SCALE);
const UNIT_TYPE = decimal128(38, UNIT_SCALE);

type PathOr = string | ((r: Row) => unknown);
const pick = (r: Row, p: PathOr) => (typeof p === "string" ? at(r, p) : p(r));

function mk(name: string, type: VgiDataType, sqlType: string, doc: string, get: (r: Row) => unknown): Col {
  return { name, type, sqlType, doc, get, nullable: true };
}

export const C = {
  id: (doc: string): Col => ({ ...mk("id", utf8(), "VARCHAR", doc, (r) => asStr(r.id)), nullable: false }),
  str: (name: string, doc: string, path: PathOr = name) =>
    mk(name, utf8(), "VARCHAR", doc, (r) => asStr(pick(r, path))),
  /** An expandable reference: always the id, whether or not the field was expanded. */
  ref: (name: string, doc: string, path: PathOr = name) => mk(name, utf8(), "VARCHAR", doc, (r) => idOf(pick(r, path))),
  time: (name: string, doc: string, path: PathOr = name) =>
    mk(name, timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", doc, (r) => asTime(pick(r, path))),
  bool: (name: string, doc: string, path: PathOr = name) =>
    mk(name, bool, "BOOLEAN", doc, (r) => asBool(pick(r, path))),
  int: (name: string, doc: string, path: PathOr = name) =>
    mk(name, int64(), "BIGINT", doc, (r) => asBigint(pick(r, path))),
  num: (name: string, doc: string, path: PathOr = name) =>
    mk(name, float64(), "DOUBLE", doc, (r) => asNum(pick(r, path))),
  strList: (name: string, doc: string, path: PathOr = name) =>
    mk(name, list(utf8()), "VARCHAR[]", doc, (r) => asStrList(pick(r, path))),
  json: (name: string, doc: string, path: PathOr = name) =>
    mk(name, utf8(), "JSON", doc, (r) => {
      const v = pick(r, path);
      return v == null ? null : JSON.stringify(redactSecrets(v));
    }),
  meta: (doc = "Your key/value metadata on the object (Stripe metadata), as a MAP.") =>
    mk("metadata", map(utf8(), utf8()), "MAP(VARCHAR, VARCHAR)", doc, (r) => asMeta(r.metadata)),
  livemode: () => C.bool("livemode", "Live mode (false = test mode)."),
  /**
   * A minor-unit amount as two columns: `<name>` BIGINT (as Stripe returns it, e.g. cents)
   * and `<name>_decimal` DECIMAL(38,3) in the major unit using the currency's exponent.
   */
  money: (name: string, doc: string, path: PathOr = name, currency: PathOr = "currency"): Col[] => [
    mk(name, int64(), "BIGINT", `${doc} (minor units)`, (r) => asBigint(pick(r, path))),
    mk(`${name}_decimal`, AMOUNT_TYPE, `DECIMAL(38,${AMOUNT_SCALE})`, `${doc} (major units, exact)`, (r) =>
      minorToDecimal(pick(r, path), pick(r, currency)),
    ),
  ],
  /** A precise unit amount from a Stripe `*_decimal` string (minor units) as DECIMAL(38,12) major units. */
  unitDecimal: (name: string, doc: string, path: PathOr, currency: PathOr = "currency") =>
    mk(name, UNIT_TYPE, `DECIMAL(38,${UNIT_SCALE})`, doc, (r) =>
      minorStringToDecimal(pick(r, path), pick(r, currency)),
    ),
  ctx: (name: string, doc: string, key: string): Col => ({
    ...mk(name, utf8(), "VARCHAR", doc, (r) => r.__ctx?.[key] ?? null),
    nullable: false,
  }),
  raw: () =>
    mk("raw", utf8(), "JSON", "The whole object as JSON, expansions included, secrets redacted.", (r) =>
      JSON.stringify(redactSecrets(r)),
    ),
};

/** Mark columns as needing `expand[]=data.<field>`. */
export function expanding(fieldName: string, cols: Col[]): Col[] {
  return cols.map((c) => ({ ...c, expands: fieldName }));
}

// --------------------------------------------------------------------- the factory

/** How a SQL column maps onto a list parameter. */
export interface ListParam {
  param: string;
  kind: "string" | "bool";
  /** Values Stripe accepts; a filter on any other value matches nothing. */
  choices?: readonly string[];
  /** Array parameter (`param[]=a&param[]=b`) that takes an IN list in one request. */
  arrayParam?: string;
  /** The parameter is only an array (`ids[]`, `lookup_keys[]`): single values go there too. */
  arrayOnly?: boolean;
  /** Rewrite the SQL value into the parameter value (undefined = cannot push). */
  value?: (v: string) => string | undefined;
}

export interface ScanContext<A> {
  args: A;
  constraints: Constraint[];
}

export interface FnExample {
  sql: string;
  description: string;
}

/** One request that starts a phase of a scan. */
export interface PhaseRequest {
  path: string;
  query: Record<string, QueryValue>;
  mode: "list" | "search" | "object";
  ctx?: Record<string, string>;
}

export interface StripeTableSpec<A> {
  name: string;
  description: string;
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  /** Text appended to doc_md describing what pushes down. */
  pushdown: string;
  examples: FnExample[];
  /** The list endpoint, e.g. `/v1/charges` (or built from the arguments). */
  path: string | ((scan: ScanContext<A>) => string);
  /** Rewrite each object before columns read it (e.g. strip a URL to its host). */
  transform?: (row: Row) => Row;
  columns: Col[];
  /** SQL column → list parameter (equality / IN / boolean). */
  params?: Record<string, ListParam>;
  /** SQL TIMESTAMPTZ column → Stripe range parameter (`created` → `created[gte]` …). */
  ranges?: Record<string, string>;
  /** Fixed or argument-derived list parameters (e.g. `status=all`), unless a pushed filter sets them. */
  baseQuery?: (scan: ScanContext<A>) => Record<string, QueryValue>;
  /** The Search API for this resource and SQL column → search field. */
  search?: { path: string; fields: Record<string, SearchField> };
  /** A single object, not a list (GET /v1/balance): `rows` turns it into rows. */
  single?: boolean;
  rows?: (body: unknown) => Row[];
  /** Per-parent fan-out (see `Fanout`). */
  fanout?: Fanout<A>;
  args?: Record<string, VgiDataType>;
  argDocs?: Record<string, string>;
  argDefaults?: Record<string, unknown>;
  argConstraints?: Record<string, Record<string, unknown>>;
  /** Override the generic `expand := […]` argument (false for single-object endpoints). */
  rawExpand?: boolean;
}

/**
 * Child collections that hang off a parent (invoice lines, subscription items, a
 * customer's payment methods). The parent id is a named argument and an output
 * column (`key`); the argument or a pushed `= / IN` filter on the column reads just
 * those parents, otherwise every parent is listed and each one's children are read in
 * turn. When the parent embeds its children (`embedded` returns them with
 * `hasMore: false`) no extra call is made for that parent.
 */
export interface Fanout<A> {
  key: string;
  /** Named argument carrying an explicit parent id. */
  arg: string;
  parent: (scan: ScanContext<A>) => { path: string; query: Record<string, QueryValue> };
  child: (id: string) => { path: string; query?: Record<string, QueryValue> };
  embedded?: (parent: Row) => { data: Row[]; hasMore: boolean } | undefined;
}

interface ScanState {
  phase: number;
  /** `starting_after` id (list) or `page` token (search); "" = first page of the phase. */
  cursor: string;
  /** Fan-out: pending parent ids, newline-joined (the head is being read). */
  queue: string;
  /** Fan-out: the parent listing's `starting_after` cursor, and whether it is exhausted. */
  parentCursor: string;
  parentDone: boolean;
}

interface CommonArgs {
  stripe_account?: string | null;
  expand?: string[] | null;
  search?: string | null;
}

/** Cap on the per-value phases an IN list may fan out into. */
const MAX_IN_PHASES = 25;
const EXPAND_PATH = /^[a-z_]+(\.[a-z_]+){0,2}$/;

export function outputSchemaOf(columns: Col[]) {
  return schema(
    columns.map((c) =>
      c.sqlType === "JSON"
        ? field(c.name, c.type, c.nullable, new Map([["comment", c.doc], JSON_META]))
        : column(c.name, c.type, c.doc, c.nullable),
    ),
  );
}

/** List parameters from pushed equality/IN/boolean constraints, plus at most one IN column to split on. */
function listParams<A>(
  spec: StripeTableSpec<A>,
  scan: ScanContext<A>,
): { query: Record<string, QueryValue>; split?: { param: string; values: string[] }; empty: boolean } {
  const query: Record<string, QueryValue> = { ...(spec.baseQuery?.(scan) ?? {}) };
  let split: { param: string; values: string[] } | undefined;
  for (const [col, p] of Object.entries(spec.params ?? {})) {
    if (p.kind === "bool") {
      const b = boolValue(scan.constraints, col);
      if (b !== undefined) query[p.param] = String(b);
      continue;
    }
    let vs = eqValues(scan.constraints, col);
    if (!vs) continue;
    if (p.value) vs = vs.map(p.value).filter((v): v is string => v !== undefined);
    if (p.choices) vs = vs.filter((v) => p.choices?.includes(v));
    if (vs.length === 0) return { query, empty: true };
    if (p.arrayOnly) {
      // More than 20 values: send none and let the SDK filter.
      if (vs.length <= 20) query[p.param] = [...vs].sort();
    } else if (vs.length === 1) query[p.param] = vs[0];
    else if (p.arrayParam && vs.length <= 20) {
      delete query[p.param];
      query[p.arrayParam] = [...vs].sort();
    } else if (!split && vs.length <= MAX_IN_PHASES) split = { param: p.param, values: vs };
  }
  for (const [col, param] of Object.entries(spec.ranges ?? {})) {
    const r = secondsRange(scan.constraints, col);
    if (!r) continue;
    if (r.gte !== undefined && r.lte !== undefined && r.gte > r.lte) return { query, empty: true };
    query[param] = r as Record<string, number>;
  }
  return { query, split, empty: false };
}

/** Whether the list API can express a constraint (equality/IN/boolean on a parameter, or a range). */
function listExpressible<A>(spec: StripeTableSpec<A>, c: Constraint): boolean {
  const p = spec.params?.[c.column];
  if (p) return c.kind === "in" ? p.kind === "string" : c.kind === "cmp" && c.op === "eq";
  if (spec.ranges?.[c.column]) return c.kind === "cmp";
  return false;
}

/** Whether Stripe Search can express a constraint (an IN list splits into one query per value). */
function searchExpressible<A>(spec: StripeTableSpec<A>, c: Constraint): boolean {
  const fields = spec.search?.fields ?? {};
  if (c.kind === "in") return fields[c.column]?.kind === "string";
  return searchClauses([c], fields).length > 0;
}

/** The phases (first requests) of a non-fan-out scan. */
export function planRequests<A extends CommonArgs>(spec: StripeTableSpec<A>, scan: ScanContext<A>): PhaseRequest[] {
  const path = typeof spec.path === "string" ? spec.path : spec.path(scan);
  if (spec.single) return [{ path, query: spec.baseQuery?.(scan) ?? {}, mode: "object" }];
  const fields = spec.search?.fields ?? {};
  // Search only when it adds a filter the list API cannot express, and the list API
  // is not already narrowing by something Search cannot (payment_intent, payout …).
  const hasSearchOnly = scan.constraints.some((c) => searchExpressible(spec, c) && !listExpressible(spec, c));
  const listOnlyPushed = scan.constraints.some((c) => listExpressible(spec, c) && !searchExpressible(spec, c));
  const useSearch = !!spec.search && (!!scan.args.search?.trim() || (hasSearchOnly && !listOnlyPushed));

  if (useSearch && spec.search) {
    // Split one IN list on a searchable string column into one query per value.
    let split: { column: string; values: string[] } | undefined;
    for (const c of scan.constraints) {
      const f = fields[c.column];
      if (c.kind === "in" && f?.kind === "string" && c.values.length <= MAX_IN_PHASES) {
        const vs = eqValues(scan.constraints, c.column);
        if (vs && vs.length > 1) {
          split = { column: c.column, values: vs };
          break;
        }
        if (vs && vs.length === 0) return [];
      }
    }
    const base = searchClauses(scan.constraints, fields, new Set(split ? [split.column] : []));
    const queries = split
      ? split.values.map((v) =>
          combineSearch(
            [...searchClauses([{ kind: "cmp", column: split.column, op: "eq", value: v }], fields), ...base],
            scan.args.search,
          ),
        )
      : [combineSearch(base, scan.args.search)];
    return queries
      .filter((q): q is string => !!q)
      .map((q) => ({ path: spec.search?.path as string, query: { query: q, limit: 100 }, mode: "search" as const }));
  }

  const { query, split, empty } = listParams(spec, scan);
  if (empty) return [];
  query.limit = 100;
  if (!split) return [{ path, query, mode: "list" }];
  return split.values.map((v) => ({ path, query: { ...query, [split.param]: v }, mode: "list" }));
}

/** Discovery tags shared by a spec's function. */
function tagsOf<A>(spec: StripeTableSpec<A>, columns: Col[]): Record<string, string> {
  return {
    domain: "payments",
    ...objectTags({
      title: spec.title,
      category: spec.category,
      keywords: spec.keywords,
      docLlm: spec.docLlm,
      docMd: `${spec.docMd}\n\n**Pushdown:** ${spec.pushdown}`,
    }),
    "vgi.result_columns_schema": JSON.stringify(
      columns.map((c) => ({ name: c.name, type: c.sqlType, description: c.doc })),
    ),
  };
}

const COMMON_ARG_DOCS = {
  stripe_account:
    "Connected account id (acct_…) to read as, sent as the Stripe-Account header; overrides the secret's STRIPE_ACCOUNT.",
  expand:
    "Extra Stripe expand paths for each object (e.g. ['customer']), returned inside the raw JSON column. Each one costs response size and latency, not extra requests; nested paths such as 'invoice.subscription' are allowed.",
  search:
    'Raw Stripe Search query (e.g. \'metadata["plan"]:"pro"\'), ANDed with pushed filters. Uses the eventually consistent Search API.',
};

export function defineStripeTable<A extends Record<string, unknown>>(spec: StripeTableSpec<A>): VgiFunction {
  const columns = [...spec.columns, C.raw()];
  const outSchema = outputSchemaOf(columns);
  const rawExpand = spec.rawExpand ?? !spec.single;
  const args: Record<string, VgiDataType> = { ...(spec.args ?? {}), stripe_account: utf8() };
  const argDefaults: Record<string, unknown> = { ...(spec.argDefaults ?? {}), stripe_account: null };
  const argDocs: Record<string, string> = { ...(spec.argDocs ?? {}), stripe_account: COMMON_ARG_DOCS.stripe_account };
  if (rawExpand) {
    args.expand = list(utf8());
    argDefaults.expand = null;
    argDocs.expand = COMMON_ARG_DOCS.expand;
  }
  if (spec.search) {
    args.search = utf8();
    argDefaults.search = null;
    argDocs.search = COMMON_ARG_DOCS.search;
  }

  return defineTableFunction<A & CommonArgs, ScanState>({
    name: spec.name,
    description: spec.description,
    args,
    argDocs,
    argDefaults,
    argConstraints: spec.argConstraints as never,
    filterPushdown: true,
    projectionPushdown: true,
    // DuckDB drops pushed predicates from its plan; the SDK re-applies them exactly,
    // so translating a predicate only ever narrows what Stripe returns.
    autoApplyFilters: true,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: ["stripe"] },
    initialState: () => ({ phase: 0, cursor: "", queue: "", parentCursor: "", parentDone: false }),
    process: async (params, state, out) => {
      const a = params.args as A & CommonArgs;
      const cfg = configFromSecrets(params.secrets, a.stripe_account);
      const scan: ScanContext<A & CommonArgs> = { args: a, constraints: constraintsOf(params.pushdownFilters) };
      log.debug(`${spec.name}: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);

      // Expansions: those the projected columns need, plus the caller's raw paths.
      const projected = new Set(params.outputSchema.fields.map((f) => f.name));
      const expand = new Set<string>();
      for (const c of columns) if (c.expands && projected.has(c.name)) expand.add(c.expands);
      for (const p of a.expand ?? []) {
        if (typeof p !== "string" || !EXPAND_PATH.test(p)) {
          throw new Error(`expand: '${p}' is not an expandable field path (e.g. 'customer' or 'invoice.subscription')`);
        }
        expand.add(p);
      }
      const expandParam = (prefix: string) => (expand.size ? [...expand].sort().map((p) => prefix + p) : undefined);

      const emit = (rows: Row[]): boolean => {
        if (rows.length === 0) return false;
        const cols: Record<string, unknown[]> = {};
        for (const f of params.outputSchema.fields) {
          const c = columns.find((x) => x.name === f.name);
          cols[f.name] = c ? rows.map((r) => c.get(r)) : rows.map(() => null);
        }
        out.emit(batchFromColumns(cols, params.outputSchema));
        return true;
      };

      /** Fetch one page of a list/search phase; returns rows and the next cursor ("" = done). */
      const page = async (req: PhaseRequest, cursor: string): Promise<{ rows: Row[]; next: string }> => {
        const query: Record<string, QueryValue> = { ...req.query };
        if (req.mode === "object") {
          const body = await stripeGet(cfg, req.path, query);
          const rows = spec.rows ? spec.rows(body) : [body as Row];
          return { rows: spec.transform ? rows.map(spec.transform) : rows, next: "" };
        }
        if (cursor) query[req.mode === "search" ? "page" : "starting_after"] = cursor;
        const ex = expandParam("data.");
        if (ex) query.expand = ex;
        const body = (await stripeGet(cfg, req.path, query)) as {
          data?: Row[];
          has_more?: boolean;
          next_page?: string | null;
        };
        const data = Array.isArray(body?.data) ? body.data : [];
        const ctx = req.ctx;
        const shaped = spec.transform ? data.map(spec.transform) : data;
        const rows = ctx ? shaped.map((r) => ({ ...r, __ctx: ctx })) : shaped;
        let next = "";
        if (body?.has_more && data.length > 0) {
          next = req.mode === "search" ? (body.next_page ?? "") : (idOf(data[data.length - 1]) ?? "");
        }
        return { rows, next };
      };

      const fan = spec.fanout;
      if (fan) {
        const explicitArg = a[fan.arg as keyof typeof a];
        const explicit =
          typeof explicitArg === "string" && explicitArg ? [explicitArg] : eqValues(scan.constraints, fan.key);
        const childQuery = (): Record<string, QueryValue> => {
          const { query } = listParams({ ...spec, baseQuery: undefined }, scan);
          return { ...query, limit: 100 };
        };
        if (explicit) {
          // Read just the named parents' children, one phase each.
          for (;;) {
            const id = explicit[state.phase];
            if (id === undefined) {
              out.finish();
              return;
            }
            const ch = fan.child(id);
            const req: PhaseRequest = {
              path: ch.path,
              query: { ...childQuery(), ...ch.query },
              mode: "list",
              ctx: { [fan.key]: id },
            };
            const p = await page(req, state.cursor);
            if (p.next) state.cursor = p.next;
            else {
              state.phase += 1;
              state.cursor = "";
            }
            if (emit(p.rows)) return;
          }
        }
        // Every parent: page the parent list, use embedded children when complete.
        for (;;) {
          if (!state.queue) {
            if (state.parentDone) {
              out.finish();
              return;
            }
            const pr = fan.parent(scan);
            const pq: Record<string, QueryValue> = { ...pr.query, limit: 100 };
            if (state.parentCursor) pq.starting_after = state.parentCursor;
            const body = (await stripeGet(cfg, pr.path, pq)) as { data?: Row[]; has_more?: boolean };
            const parents = Array.isArray(body?.data) ? body.data : [];
            if (body?.has_more && parents.length > 0) state.parentCursor = idOf(parents[parents.length - 1]) ?? "";
            else state.parentDone = true;
            const ready: Row[] = [];
            const pending: string[] = [];
            for (const parent of parents) {
              const id = idOf(parent);
              if (!id) continue;
              const emb = expand.size ? undefined : fan.embedded?.(parent);
              if (emb && !emb.hasMore) ready.push(...emb.data.map((r) => ({ ...r, __ctx: { [fan.key]: id } })));
              else pending.push(id);
            }
            state.queue = pending.join("\n");
            if (emit(ready)) return;
            continue;
          }
          const ids = state.queue.split("\n");
          const id = ids[0] as string;
          const ch = fan.child(id);
          const req: PhaseRequest = {
            path: ch.path,
            query: { ...childQuery(), ...ch.query },
            mode: "list",
            ctx: { [fan.key]: id },
          };
          const p = await page(req, state.cursor);
          if (p.next) state.cursor = p.next;
          else {
            state.queue = ids.slice(1).join("\n");
            state.cursor = "";
          }
          if (emit(p.rows)) return;
        }
      }

      const phases = planRequests(spec, scan);
      if (state.phase === 0 && state.cursor === "") {
        log.debug(
          `${spec.name}: ${phases.length} phase(s): ${phases.map((p) => `${p.mode} ${JSON.stringify(p.query)}`).join("; ")}`,
        );
      }
      // Loop until a page yields rows or the scan ends, so no empty batches go out.
      for (;;) {
        const phase = phases[state.phase];
        if (!phase) {
          out.finish();
          return;
        }
        const p = await page(phase, state.cursor);
        if (p.next) state.cursor = p.next;
        else {
          state.phase += 1;
          state.cursor = "";
        }
        if (emit(p.rows)) return;
      }
    },
    tags: tagsOf(spec, columns),
    examples: spec.examples,
  });
}

/** Exported for unit tests. */
export type { StripeConfig };
