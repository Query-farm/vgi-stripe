/**
 * The spec-driven layer: one table function per Stripe GET endpoint, built at start-up from
 * `generated/endpoints.json` (written by `scripts/generate_api.py` from the vendored OpenAPI
 * spec), plus `stripe.api.get(path, params := MAP)`, a raw JSON escape hatch for any
 * documented GET.
 *
 * Each descriptor names the endpoint, its columns (with an extraction kind derived from the
 * response schema), the list parameters a WHERE clause can push down (equality / IN /
 * boolean / `ids[]` arrays / time ranges / retrieve-by-id), the remaining query parameters as
 * named arguments, and — for nested lists — the parent to fan out over. Everything else
 * (paging cursors, Search, expansion, retries, redaction, exact re-filtering by the SDK) is
 * the shared factory in table.ts, the same one the curated `stripe.main` functions use.
 */

import {
  batchFromColumns,
  bool,
  decimal128,
  defineTableFunction,
  float64,
  int64,
  map,
  struct,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
} from "@query-farm/vgi";
import { CATALOG_NAME, column, keywordsArray } from "../meta.ts";
import { configFromSecrets, type QueryValue, StripeError, stripeGet } from "./client.ts";
import endpointsFile from "./generated/endpoints.json" with { type: "json" };
import { AMOUNT_SCALE, minorToDecimal } from "./money.ts";
import { eqValues } from "./pushdown.ts";
import {
  asBigint,
  asBool,
  asNum,
  asStr,
  asTime,
  at,
  C,
  type Col,
  defineStripeTable,
  type ListParam,
  outputSchemaOf,
  type Row,
  redactSecrets,
  type ScanContext,
  type StripeTableSpec,
} from "./table.ts";

// ------------------------------------------------------------------ descriptor types

type Kind =
  | "id"
  | "key"
  | "str"
  | "ref"
  | "time"
  | "int"
  | "num"
  | "bool"
  | "money"
  | "meta"
  | "strList"
  | "json"
  | "struct";

interface ColDesc {
  n: string;
  k: Kind;
  d: string;
  p?: string;
  f?: [string, string][];
  enum?: string[];
}

interface ArgDesc {
  n: string;
  p: string;
  t: "VARCHAR" | "BIGINT" | "BOOLEAN" | "TIMESTAMPTZ";
  d: string;
  req: boolean;
  ch?: string[];
  col?: string;
  /** Default value (for a parameter Stripe requires that has one sensible value). */
  def?: string;
}

interface FanoutDesc {
  key: string;
  arg: string;
  mode: "list" | "object";
  child: string;
  pathParam?: string;
  queryParam?: string;
  parent: string | null;
  parentQuery: Record<string, string>;
  fromParent?: Record<string, string>;
}

export interface EndpointDesc {
  schema: string;
  name: string;
  category: string;
  path: string;
  mode: "list" | "single" | "retrieve" | "sub";
  object: string;
  summary: string;
  detail: string;
  retrieve: string | null;
  search: string | null;
  fanout: FanoutDesc | null;
  paging: { limit: boolean; cursor: boolean };
  baseQuery: Record<string, string>;
  params: { c: string; p: string; k: "string" | "bool"; ch?: string[]; arr?: string; only?: boolean }[];
  ranges: { c: string; p: string }[];
  args: ArgDesc[];
  query_params: string[];
  columns: ColDesc[];
  example: { sql: string; description: string };
  task: { name: string; prompt: string; reference_sql: string };
}

interface SchemaDesc {
  title: string;
  description: string;
  categories: { name: string; title: string; description: string }[];
}

interface EndpointsFile {
  spec: { commit: string; api_version: string; source: string };
  schemas: Record<string, SchemaDesc>;
  get_paths: string[];
  endpoints: EndpointDesc[];
}

export const GENERATED = endpointsFile as unknown as EndpointsFile;

/** Curated stripe.main functions reading the same endpoint (the recommended entry points). */
const CURATED: Record<string, string> = {
  "/v1/balance": "balance",
  "/v1/balance_transactions": "balance_transactions",
  "/v1/payouts": "payouts",
  "/v1/charges": "charges",
  "/v1/payment_intents": "payment_intents",
  "/v1/refunds": "refunds",
  "/v1/disputes": "disputes",
  "/v1/radar/early_fraud_warnings": "early_fraud_warnings",
  "/v1/checkout/sessions": "checkout_sessions",
  "/v1/customers": "customers",
  "/v1/customers/{customer}/payment_methods": "payment_methods",
  "/v1/invoices": "invoices",
  "/v1/invoices/{invoice}/lines": "invoice_line_items",
  "/v1/invoiceitems": "invoice_items",
  "/v1/subscriptions": "subscriptions",
  "/v1/subscription_items": "subscription_items",
  "/v1/subscription_schedules": "subscription_schedules",
  "/v1/credit_notes": "credit_notes",
  "/v1/billing/meters": "billing_meters",
  "/v1/billing/meters/{id}/event_summaries": "meter_event_summaries",
  "/v1/products": "products",
  "/v1/prices": "prices",
  "/v1/coupons": "coupons",
  "/v1/promotion_codes": "promotion_codes",
  "/v1/tax_rates": "tax_rates",
  "/v1/accounts": "accounts",
  "/v1/application_fees": "application_fees",
  "/v1/transfers": "transfers",
  "/v1/events": "events",
  "/v1/webhook_endpoints": "webhook_endpoints",
  "/v1/files": "files",
};

/** Schemas whose function names drop the product prefix ("issuing.cards" → "Issuing Cards"). */
const PRODUCT_WORD: Record<string, string> = {
  issuing: "Issuing",
  treasury: "Treasury",
  terminal: "Terminal",
  identity: "Identity",
  financial_connections: "Financial Connections",
  climate: "Climate",
  reporting: "Reporting",
  tax: "Tax",
};

export function titleOf(ep: EndpointDesc): string {
  const fix: Record<string, string> = { id: "ID", ids: "IDs", "3d": "3D", sigma: "Sigma" };
  const words = ep.name
    .split("_")
    .map((w) => fix[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const product = PRODUCT_WORD[ep.schema];
  return product && !words.startsWith(product.split(" ")[0] as string) ? `${product} ${words}` : words;
}

// ------------------------------------------------------------------ columns

const AMOUNT_TYPE = decimal128(38, AMOUNT_SCALE);
const SQL_OF: Record<string, string> = {
  str: "VARCHAR",
  int: "BIGINT",
  num: "DOUBLE",
  bool: "BOOLEAN",
  time: "TIMESTAMP WITH TIME ZONE",
};
const TYPE_OF = (k: string): VgiDataType =>
  k === "int"
    ? int64()
    : k === "num"
      ? float64()
      : k === "bool"
        ? bool
        : k === "time"
          ? timestampMicros("UTC")
          : utf8();
const CONVERT: Record<string, (v: unknown) => unknown> = {
  str: asStr,
  int: asBigint,
  num: asNum,
  bool: asBool,
  time: asTime,
};

/** Columns for one descriptor (the factory appends `raw`). */
export function columnsOf(cols: ColDesc[]): Col[] {
  const out: Col[] = [];
  for (const c of cols) {
    const doc = c.d;
    switch (c.k) {
      case "id":
        out.push(C.id(doc));
        break;
      case "key": {
        const key = c.n;
        out.push({
          name: key,
          type: utf8(),
          sqlType: "VARCHAR",
          doc,
          nullable: false,
          get: (r: Row) => {
            const v = at(r, key);
            const own = typeof v === "string" ? v : v && typeof v === "object" ? (v as { id?: string }).id : undefined;
            return own ?? r.__ctx?.[key] ?? null;
          },
        });
        break;
      }
      case "str":
        out.push(C.str(c.n, doc));
        break;
      case "ref":
        out.push(C.ref(c.n, doc));
        break;
      case "time":
        out.push(C.time(c.n, doc));
        break;
      case "int":
        out.push(C.int(c.n, doc));
        break;
      case "num":
        out.push(C.num(c.n, doc));
        break;
      case "bool":
        out.push(C.bool(c.n, doc));
        break;
      case "money": {
        const name = c.n;
        out.push(C.int(name, `${doc} (minor units)`));
        out.push({
          name: `${name}_decimal`,
          type: AMOUNT_TYPE,
          sqlType: `DECIMAL(38,${AMOUNT_SCALE})`,
          doc: "Same amount in major units (exact).",
          nullable: true,
          get: (r: Row) => minorToDecimal(r[name], r.currency),
        });
        break;
      }
      case "meta":
        out.push(C.meta(doc));
        break;
      case "strList":
        out.push(C.strList(c.n, doc));
        break;
      case "struct": {
        const fields = c.f ?? [];
        const name = c.n;
        out.push({
          name,
          type: struct(fields.map(([fname, k]) => column(fname, TYPE_OF(k), `${name}.${fname}`))),
          sqlType: `STRUCT(${fields.map(([fname, k]) => `"${fname}" ${SQL_OF[k] ?? "VARCHAR"}`).join(", ")})`,
          doc,
          nullable: true,
          get: (r: Row) => {
            const v = r[name];
            if (!v || typeof v !== "object" || Array.isArray(v)) return null;
            const o: Record<string, unknown> = {};
            for (const [fname, k] of fields) o[fname] = (CONVERT[k] ?? asStr)((v as Record<string, unknown>)[fname]);
            return o;
          },
        });
        break;
      }
      default:
        out.push(C.json(c.n, doc));
    }
  }
  return out;
}

// ------------------------------------------------------------------ arguments

const ARG_TYPE: Record<ArgDesc["t"], () => VgiDataType> = {
  VARCHAR: () => utf8(),
  BIGINT: () => int64(),
  BOOLEAN: () => bool,
  TIMESTAMPTZ: () => timestampMicros("UTC"),
};

/** A TIMESTAMPTZ argument value (µs bigint, ms number or Date) as Unix seconds. */
export function argSeconds(v: unknown): number | undefined {
  if (typeof v === "bigint") return Number(v / 1_000_000n);
  if (typeof v === "number") return Math.floor(v / 1_000_000);
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  return undefined;
}

function argValue(a: ArgDesc, v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (a.t === "TIMESTAMPTZ") {
    const s = argSeconds(v);
    return s === undefined ? undefined : String(s);
  }
  return String(v);
}

const PARAMS_DOC =
  "Extra Stripe query parameters for this endpoint, keyed by bracketed parameter name, e.g. {'relationship[owner]': 'true'}; only the endpoint's documented parameters are accepted (paging, expand and limit are managed for you).";
const MANAGED = new Set(["limit", "starting_after", "ending_before", "page", "expand", "query"]);

/** Validate and return the raw `params := MAP{…}` for an endpoint. */
export function rawParams(ep: { name: string; query_params: string[] }, m: unknown): Record<string, string> {
  if (m == null) return {};
  const entries: [string, unknown][] =
    m instanceof Map
      ? [...m.entries()]
      : Array.isArray(m)
        ? m.map((e) => (Array.isArray(e) ? [e[0], e[1]] : [e.key, e.value]))
        : Object.entries(m as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const key = String(k);
    const top = key.split("[")[0] ?? key;
    if (!/^[a-z_]+(\[[a-z_0-9]*\])*$/.test(key)) {
      throw new StripeError(`${ep.name}: params key '${key}' is not a Stripe parameter name (e.g. 'created[gte]')`);
    }
    if (MANAGED.has(top)) {
      throw new StripeError(`${ep.name}: params cannot set '${top}' (paging, expand and search are managed)`);
    }
    if (!ep.query_params.includes(top)) {
      throw new StripeError(
        `${ep.name}: '${top}' is not a documented parameter of this endpoint (allowed: ${ep.query_params.filter((p) => !MANAGED.has(p)).join(", ") || "none"})`,
      );
    }
    if (v != null) out[key] = String(v);
  }
  return out;
}

// ------------------------------------------------------------------ docs

function pushdownText(ep: EndpointDesc): string {
  const parts: string[] = [];
  const eq = ep.params.filter((p) => p.k === "string").map((p) => `\`${p.c}\` (= / IN)`);
  const bools = ep.params.filter((p) => p.k === "bool").map((p) => `\`${p.c}\``);
  if (eq.length) parts.push(`${eq.join(", ")} → list parameters`);
  if (bools.length) parts.push(`boolean ${bools.join(", ")}`);
  if (ep.ranges.length) parts.push(`time ranges on ${ep.ranges.map((r) => `\`${r.c}\``).join(", ")} → [gt/gte/lt/lte]`);
  if (ep.retrieve) parts.push(`\`id\` = / IN (≤25) → one GET ${ep.retrieve} per id`);
  if (ep.args.length)
    parts.push(
      `named arguments ${ep.args.map((a) => `\`${a.n}\``).join(", ")} → Stripe parameters (${ep.args.map((a) => a.p).join(", ")})`,
    );
  if (ep.search) parts.push(`\`search :=\` → ${ep.search}`);
  if (ep.fanout) {
    const f = ep.fanout;
    parts.push(
      f.parent
        ? `\`${f.arg} :=\` or \`${f.key}\` = / IN → one ${f.mode === "object" ? "GET" : "listing"} per parent; otherwise fans out over every parent in ${f.parent} (1 + parents/100 + parents requests)`
        : `\`${f.arg} :=\` or \`${f.key}\` = / IN is required (Stripe has no list to fan out over)`,
    );
  }
  if (!parts.length) parts.push(ep.mode === "single" ? "nothing (one call returns the object)" : "none (paged)");
  return `${parts.join("; ")}. Every filter is re-applied exactly by DuckDB/the SDK.`;
}

function signature(ep: EndpointDesc): string {
  const a: string[] = [];
  if (ep.fanout) a.push(`${ep.fanout.arg} := NULL`);
  for (const x of ep.args) a.push(`${x.n} := NULL`);
  if (ep.search) a.push("search := NULL");
  a.push("params := NULL");
  return `${ep.name}(${a.join(", ")})`;
}

function docLlm(ep: EndpointDesc, version: string): string {
  const curated = CURATED[ep.path];
  const text =
    `${ep.detail || ep.summary} Endpoint: GET ${ep.path} (Stripe API ${version}), one row per ${ep.object} ` +
    `object (${ep.mode === "single" ? "a single object" : ep.mode === "list" ? "paged 100 at a time" : "one GET per id"}). ` +
    "Columns are Stripe's own field names: expandable references are ids, Unix times are `TIMESTAMPTZ`, minor-unit " +
    "amounts beside a currency are `BIGINT` with an exact `*_decimal` major-unit companion, metadata is a `MAP`, " +
    "deeper objects are `JSON`, and `raw` holds the whole object with credentials redacted. " +
    `Pushdown: ${pushdownText(ep)}` +
    (curated ? ` The curated stripe.main.${curated}() reads the same endpoint with friendlier columns.` : "") +
    " Needs a `stripe` secret.";
  return text.length > 3900 ? `${text.slice(0, 3899)}…` : text;
}

function docMd(ep: EndpointDesc): string {
  const curated = CURATED[ep.path];
  return (
    `## ${signature(ep)}\n\n${ep.summary || ep.detail}\n\n` +
    `**Endpoint:** \`GET ${ep.path}\` (generated from Stripe's OpenAPI spec).` +
    (curated ? ` Prefer \`stripe.main.${curated}()\` for analysis.` : "")
  );
}

// ------------------------------------------------------------------ the factory

type Args = Record<string, unknown> & { params?: unknown };

export function defineEndpoint(ep: EndpointDesc, version: string): VgiFunction {
  const cols = columnsOf(ep.columns);
  const params: Record<string, ListParam> = {};
  for (const p of ep.params) {
    params[p.c] = {
      param: p.p,
      kind: p.k,
      ...(p.ch ? { choices: p.ch } : {}),
      ...(p.arr && !p.only ? { arrayParam: p.arr } : {}),
      ...(p.only ? { arrayOnly: true, param: p.arr ?? p.p } : {}),
    };
  }
  const ranges: Record<string, string> = {};
  for (const r of ep.ranges) ranges[r.c] = r.p;

  const args: Record<string, VgiDataType> = {};
  const argDocs: Record<string, string> = {};
  const argDefaults: Record<string, unknown> = {};
  const argConstraints: Record<string, Record<string, unknown>> = {};
  const fan = ep.fanout;
  if (fan) {
    args[fan.arg] = utf8();
    argDefaults[fan.arg] = null;
    argDocs[fan.arg] = fan.parent
      ? `Read only this parent's rows (${fan.key} id); NULL fans out over every parent.`
      : `The ${fan.key === "id" ? "object" : fan.key} id to read (required unless WHERE ${fan.key} = / IN names them).`;
  }
  for (const a of ep.args) {
    args[a.n] = ARG_TYPE[a.t]();
    argDefaults[a.n] = a.def ?? null;
    argDocs[a.n] =
      `${a.d}${a.req ? " Required by Stripe." : ""}${a.def ? ` Default '${a.def}'.` : ""} (Stripe parameter ${a.p})`;
    if (a.ch?.length && a.ch.length > 1) argConstraints[a.n] = { choices: a.ch };
  }
  args.params = map(utf8(), utf8());
  argDefaults.params = null;
  argDocs.params = PARAMS_DOC;

  const argQuery = (scan: ScanContext<Args>): Record<string, QueryValue> => {
    const q: Record<string, QueryValue> = { ...ep.baseQuery, ...rawParams(ep, scan.args.params) };
    for (const a of ep.args) {
      let v = argValue(a, scan.args[a.n]);
      if (v === undefined && a.col) {
        const vs = eqValues(scan.constraints, a.col);
        if (vs?.length === 1) v = vs[0];
      }
      if (v !== undefined) q[a.p] = v;
    }
    return q;
  };
  const check = (scan: ScanContext<Args>) => {
    const q = argQuery(scan);
    for (const a of ep.args) {
      if (a.req && q[a.p] === undefined) {
        const how = a.col ? ` or filter WHERE ${a.col} = '…'` : "";
        throw new StripeError(`${ep.name}: ${a.n} := is required by Stripe (parameter ${a.p})${how}`);
      }
    }
  };

  const fillPath = (tpl: string, id: string) => tpl.replace(/\{\w+\}/, encodeURIComponent(id));
  const spec: StripeTableSpec<Args> = {
    name: ep.name,
    description: `${ep.summary || `Rows of ${ep.object}`} (GET ${ep.path})`,
    title: titleOf(ep),
    category: ep.category,
    keywords: [
      "stripe",
      ep.schema.replace(/_/g, " "),
      ep.object.replace(/[._]/g, " "),
      ep.name.replace(/_/g, " "),
      ep.path,
    ].join(", "),
    docLlm: docLlm(ep, version),
    docMd: docMd(ep),
    pushdown: pushdownText(ep),
    examples: [ep.example],
    path: ep.path,
    columns: cols,
    params,
    ranges,
    baseQuery: argQuery,
    check,
    args,
    argDocs,
    argDefaults,
    argConstraints,
    paging: ep.paging,
    retrieve: ep.retrieve ?? undefined,
    single: ep.mode === "single",
    rawExpand: ep.mode !== "single",
    ...(ep.search ? { search: { path: ep.search, fields: {} } } : {}),
  };
  if (fan) {
    spec.fanout = {
      key: fan.key,
      arg: fan.arg,
      object: fan.mode === "object",
      keepBaseQuery: true,
      ...(fan.fromParent ? { fromParent: fan.fromParent } : {}),
      ...(fan.parent ? { parent: () => ({ path: fan.parent as string, query: { ...fan.parentQuery } }) } : {}),
      child: (id, fromParent) => {
        if (fan.queryParam) return { path: fan.child, query: { [fan.queryParam]: id } };
        return { path: fillPath(fan.child, id), query: { ...(fromParent ?? {}) } };
      },
    };
  }
  const fn = defineStripeTable<Args>(spec);
  fn.meta.tags = {
    ...fn.meta.tags,
    "vgi.keywords": keywordsArray(spec.keywords),
    "stripe.endpoint": `GET ${ep.path}`,
  };
  return fn;
}

// ------------------------------------------------------------------ api.get

const GET_PATTERNS = GENERATED.get_paths.map(
  (p) => new RegExp(`^${p.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{\w+\}/g, "(?!\\.+(?:/|$))[A-Za-z0-9_.:-]+")}$`),
);

/** Whether `path` is a documented Stripe GET (a spec template with its ids filled in). */
export function isDocumentedGet(path: string): boolean {
  return GET_PATTERNS.some((re) => re.test(path));
}

const GET_COLUMNS: Col[] = [
  { ...C.str("path", "The requested API path."), nullable: false },
  C.str("object", "Stripe's object type of the response (e.g. charge, list)."),
  C.json("body", "The whole JSON response, credentials redacted."),
];

export const apiGet: VgiFunction = (() => {
  const outSchema = outputSchemaOf(GET_COLUMNS);
  return defineTableFunction<{ path: string; params: unknown; stripe_account: string | null }, { done: boolean }>({
    name: "get",
    description: "Raw read of any documented Stripe GET endpoint as one JSON row (an escape hatch for single objects)",
    args: { path: utf8(), params: map(utf8(), utf8()), stripe_account: utf8() },
    argDefaults: { params: null, stripe_account: null },
    argDocs: {
      path: "A documented Stripe GET path with its ids filled in, e.g. '/v1/charges/ch_123' or '/v1/account'.",
      params: "Query parameters keyed by bracketed parameter name, e.g. {'expand[]': 'customer'}.",
      stripe_account: "Connected account id (acct_…) to read as, sent as the Stripe-Account header.",
    },
    argConstraints: { path: { pattern: "^/v1/" } } as never,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: ["stripe"] },
    initialState: () => ({ done: false }),
    process: async (params, state, out) => {
      if (state.done) {
        out.finish();
        return;
      }
      const a = params.args;
      const path = String(a.path ?? "");
      if (!isDocumentedGet(path)) {
        throw new StripeError(
          `api.get: '${path}' is not a documented Stripe GET endpoint (Stripe API ${GENERATED.spec.api_version}); writes and undocumented paths are refused`,
        );
      }
      const cfg = configFromSecrets(params.secrets, a.stripe_account);
      const query: Record<string, QueryValue> = {};
      for (const [k, v] of Object.entries(rawParamsAny(a.params))) {
        if (k === "expand[]") {
          const prev = query.expand;
          query.expand = [...(Array.isArray(prev) ? prev : []), v];
        } else query[k] = v;
      }
      const body = await stripeGet(cfg, path, query);
      const red = redactSecrets(body) as Record<string, unknown> | null;
      const row: Row = { path, object: red?.object ?? null, body: red };
      const cols: Record<string, unknown[]> = {};
      for (const f of params.outputSchema.fields) {
        const c = GET_COLUMNS.find((x) => x.name === f.name);
        cols[f.name] = [c ? (c.name === "body" ? JSON.stringify(red) : c.get(row)) : null];
      }
      state.done = true;
      out.emit(batchFromColumns(cols, params.outputSchema));
    },
    tags: {
      domain: "payments",
      "vgi.title": "Raw GET",
      "vgi.category": "raw",
      "vgi.keywords": keywordsArray("stripe, raw, json, retrieve, get, any endpoint, escape hatch, single object"),
      "vgi.doc_llm":
        "Escape hatch: GET any documented Stripe v1 read endpoint and return the response as one row (path, " +
        "object, body JSON with credentials redacted). Use it for single objects by id (a charge, a mandate, a " +
        "tax calculation) or endpoints whose fields you want verbatim; prefer the typed table functions for lists. " +
        "The path must match a GET in Stripe's OpenAPI spec (writes are impossible: only GET is ever sent). " +
        "params := {'expand[]': 'customer'} (a `MAP` of parameter names to values) adds query parameters. Needs a `stripe` secret.",
      "vgi.doc_md":
        "## get(path, params := NULL, stripe_account := NULL)\n\nOne JSON row for any documented Stripe GET.\n\n" +
        "Only paths that match a GET in the vendored OpenAPI spec are accepted; credentials are redacted from the body.",
      "vgi.result_columns_schema": JSON.stringify(
        GET_COLUMNS.map((c) => ({ name: c.name, type: c.sqlType, description: c.doc })),
      ),
    },
    examples: [
      {
        sql: `SELECT body->>'$.country' AS country, body->>'$.default_currency' AS currency FROM ${CATALOG_NAME}.api.get('/v1/account')`,
        description: "Your account's country and default currency from the raw account object",
      },
    ],
  });
})();

function rawParamsAny(m: unknown): Record<string, string> {
  if (m == null) return {};
  const entries: [string, unknown][] =
    m instanceof Map
      ? [...m.entries()]
      : Array.isArray(m)
        ? m.map((e) => (Array.isArray(e) ? [e[0], e[1]] : [e.key, e.value]))
        : Object.entries(m as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const key = String(k);
    if (!/^[a-z_]+(\[[a-z_0-9]*\])*$/.test(key) || /^(limit|starting_after|ending_before)$/.test(key)) {
      throw new StripeError(`api.get: params key '${key}' is not an allowed Stripe parameter name`);
    }
    if (v != null) out[key] = String(v);
  }
  return out;
}

// ------------------------------------------------------------------ assembly

export interface GeneratedSchema {
  name: string;
  desc: SchemaDesc;
  functions: VgiFunction[];
  endpoints: EndpointDesc[];
}

export function generatedSchemas(): GeneratedSchema[] {
  const by = new Map<string, GeneratedSchema>();
  for (const [name, desc] of Object.entries(GENERATED.schemas))
    by.set(name, { name, desc, functions: [], endpoints: [] });
  for (const ep of GENERATED.endpoints) {
    const s = by.get(ep.schema);
    if (!s) throw new Error(`generated endpoint ${ep.name}: unknown schema ${ep.schema}`);
    s.functions.push(defineEndpoint(ep, GENERATED.spec.api_version));
    s.endpoints.push(ep);
  }
  return [...by.values()].filter((s) => s.functions.length > 0);
}

/** For tests: a copy of the descriptor list. */
export const ENDPOINTS: readonly EndpointDesc[] = GENERATED.endpoints;
