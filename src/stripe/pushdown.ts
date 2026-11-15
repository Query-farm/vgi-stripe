/**
 * Turn DuckDB's pushed-down WHERE predicates into Stripe list parameters or a Stripe
 * Search query.
 *
 * Every table function sets `autoApplyFilters: true`, so the SDK re-applies every
 * pushed predicate to each batch exactly. Translation therefore only has to NARROW the
 * upstream request without ever dropping a matching row: predicates we cannot express
 * are simply not sent, and anything Stripe matches more loosely (Search's
 * case-insensitive or substring matches) is tightened again by the SDK.
 *
 * Only top-level conjuncts are translated (a predicate under OR/NOT is left to the
 * SDK), so every generated parameter is implied by the SQL filter.
 */

import type { PushdownFilters } from "@query-farm/vgi";

type Expr = PushdownFilters["filters"][number];

/** One translatable constraint on a column. */
export type Constraint =
  | { kind: "cmp"; column: string; op: "eq" | "gt" | "ge" | "lt" | "le"; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "prefix"; column: string; value: string }
  | { kind: "contains"; column: string; value: string };

const FLIP: Record<string, "eq" | "gt" | "ge" | "lt" | "le"> = { eq: "eq", gt: "lt", ge: "le", lt: "gt", le: "ge" };

function unwrap(e: Expr): Expr {
  return e.node === "cast" ? unwrap(e.expression) : e;
}

function one(e: Expr, out: Constraint[]): void {
  // A bare boolean column (`WHERE refunded`) and its negation.
  if (e.node === "column_ref") {
    out.push({ kind: "cmp", column: e.columnName, op: "eq", value: true });
    return;
  }
  if (e.node === "not" && unwrap(e.expression).node === "column_ref") {
    const c = unwrap(e.expression) as Extract<Expr, { node: "column_ref" }>;
    out.push({ kind: "cmp", column: c.columnName, op: "eq", value: false });
    return;
  }
  if (e.node === "and") {
    for (const c of e.children) one(c, out);
    return;
  }
  if (e.node === "comparison" && e.op in FLIP) {
    const [l, r] = [unwrap(e.left), unwrap(e.right)];
    if (l.node === "column_ref" && r.node === "literal" && r.value != null) {
      out.push({ kind: "cmp", column: l.columnName, op: e.op as "eq", value: r.value });
    } else if (r.node === "column_ref" && l.node === "literal" && l.value != null) {
      out.push({ kind: "cmp", column: r.columnName, op: FLIP[e.op] ?? "eq", value: l.value });
    }
    return;
  }
  if (e.node === "in" && !e.negated && e.set.kind === "literal") {
    const col = unwrap(e.expression);
    const values = e.set.values.filter((v) => v != null);
    if (col.node === "column_ref" && values.length > 0 && values.length === e.set.values.length) {
      out.push({ kind: "in", column: col.columnName, values });
    }
    return;
  }
  if (e.node === "call" && (e.function === "starts_with" || e.function === "contains") && e.arguments.length === 2) {
    const [c, v] = [unwrap(e.arguments[0] as Expr), unwrap(e.arguments[1] as Expr)];
    if (c.node === "column_ref" && v.node === "literal" && typeof v.value === "string") {
      out.push({ kind: e.function === "starts_with" ? "prefix" : "contains", column: c.columnName, value: v.value });
    }
  }
}

/** The top-level, translatable constraints of a scan's pushed filters. */
export function constraintsOf(filters: PushdownFilters | undefined): Constraint[] {
  const out: Constraint[] = [];
  for (const f of filters?.filters ?? []) one(f, out);
  return [...out, ...prefixesFromRanges(out)];
}

/** The string after every string starting with `p` (DuckDB's prefix-range upper bound). */
function prefixSuccessor(p: string): string | undefined {
  if (!p) return undefined;
  const last = p.codePointAt(p.length - 1);
  return last === undefined ? undefined : p.slice(0, -1) + String.fromCodePoint(last + 1);
}

/**
 * DuckDB rewrites `starts_with(col, 'ad')` and `col LIKE 'ad%'` into the range
 * `col >= 'ad' AND col < 'ae'`. Recognise that pair and add a prefix constraint.
 */
function prefixesFromRanges(cs: Constraint[]): Constraint[] {
  const out: Constraint[] = [];
  for (const lo of cs) {
    if (lo.kind !== "cmp" || lo.op !== "ge" || typeof lo.value !== "string") continue;
    const hi = prefixSuccessor(lo.value);
    if (cs.some((c) => c.kind === "cmp" && c.column === lo.column && c.op === "lt" && c.value === hi)) {
      out.push({ kind: "prefix", column: lo.column, value: lo.value });
    }
  }
  return out;
}

/** A pushed literal for a TIMESTAMPTZ column as epoch milliseconds (µs bigint, ms number, Date, ISO). */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === "bigint") return Number(v / 1000n);
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** Stripe range bounds in whole Unix seconds. */
export interface SecondsRange {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

/**
 * The bounds the constraints put on a time column, as Stripe's integer-second
 * `[gt|gte|lt|lte]` operators. Stripe timestamps are whole seconds, so each SQL bound
 * becomes the exactly-equivalent integer bound (e.g. `> 10.5 s` → `gt 10`, `>= 10.5 s`
 * → `gte 11`); the tightest bound per side wins.
 */
export function secondsRange(constraints: Constraint[], column: string): SecondsRange | undefined {
  let lower: number | undefined; // created >= lower
  let upper: number | undefined; // created <= upper
  for (const c of constraints) {
    if (c.column !== column || c.kind !== "cmp") continue;
    const ms = toEpochMs(c.value);
    if (ms === undefined) continue;
    const s = ms / 1000;
    let lo: number | undefined;
    let hi: number | undefined;
    if (c.op === "gt") lo = Math.floor(s) + 1;
    if (c.op === "ge" || c.op === "eq") lo = Math.ceil(s);
    if (c.op === "lt") hi = Math.ceil(s) - 1;
    if (c.op === "le" || c.op === "eq") hi = Math.floor(s);
    if (lo !== undefined) lower = lower === undefined ? lo : Math.max(lower, lo);
    if (hi !== undefined) upper = upper === undefined ? hi : Math.min(upper, hi);
  }
  if (lower === undefined && upper === undefined) return undefined;
  const r: SecondsRange = {};
  if (lower !== undefined) r.gte = lower;
  if (upper !== undefined) r.lte = upper;
  return r;
}

/** Equality / IN values pushed for a column (as strings), or undefined if unconstrained. */
export function eqValues(constraints: Constraint[], column: string): string[] | undefined {
  let set: string[] | undefined;
  for (const c of constraints) {
    if (c.column !== column) continue;
    let vs: string[] | undefined;
    if (c.kind === "cmp" && c.op === "eq" && typeof c.value === "string") vs = [c.value];
    else if (c.kind === "in" && c.values.every((v) => typeof v === "string")) vs = c.values as string[];
    if (!vs) continue;
    set = set ? set.filter((v) => vs.includes(v)) : [...new Set(vs)];
  }
  return set;
}

/** A pushed boolean equality on a column, or undefined. */
export function boolValue(constraints: Constraint[], column: string): boolean | undefined {
  for (const c of constraints) {
    if (c.column === column && c.kind === "cmp" && c.op === "eq" && typeof c.value === "boolean") return c.value;
  }
  return undefined;
}

/** A pushed prefix (starts_with / LIKE 'x%') on a column, or undefined. */
export function prefixValue(constraints: Constraint[], column: string): string | undefined {
  for (const c of constraints) if (c.column === column && c.kind === "prefix") return c.value;
  return undefined;
}

// ------------------------------------------------------------------ Stripe Search

/**
 * Quote a value for Stripe's search query language: double quotes, with `\` and `"`
 * escaped by a backslash.
 */
export function searchQuote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** How one SQL column maps onto a Stripe search field. */
export interface SearchField {
  /** Stripe search field, e.g. `email` or `payment_method_details.card.last4`. */
  field: string;
  kind: "string" | "number" | "time" | "bool";
  /** Allow `~` (substring) clauses for starts_with / contains (Stripe needs 3+ characters). */
  substring?: boolean;
}

/** Stripe allows at most 10 clauses per search query. */
export const MAX_SEARCH_CLAUSES = 10;

const SEARCH_OPS: Record<string, string> = { eq: ":", gt: ">", ge: ">=", lt: "<", le: "<=" };

/**
 * Build Stripe search clauses (`field:"v"`, `amount>100`, `created>=1700000000`,
 * `name~"acme"`) from the constraints, one per constraint. An IN list on a column is
 * skipped here (Stripe Search cannot mix OR with AND); callers split it into one query
 * per value instead.
 */
export function searchClauses(
  constraints: Constraint[],
  fields: Record<string, SearchField>,
  skipColumns: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  for (const c of constraints) {
    const f = fields[c.column];
    if (!f || skipColumns.has(c.column)) continue;
    if (c.kind === "cmp") {
      const op = SEARCH_OPS[c.op];
      if (!op) continue;
      if (f.kind === "string") {
        if (c.op === "eq" && typeof c.value === "string") out.push(`${f.field}:${searchQuote(c.value)}`);
      } else if (f.kind === "bool") {
        if (c.op === "eq" && typeof c.value === "boolean") out.push(`${f.field}:${searchQuote(String(c.value))}`);
      } else if (f.kind === "number") {
        const n = typeof c.value === "bigint" ? c.value : typeof c.value === "number" ? c.value : undefined;
        if (n !== undefined && (typeof n === "bigint" || Number.isInteger(n))) out.push(`${f.field}${op}${n}`);
      } else if (f.kind === "time") {
        const r = secondsRange([c], c.column);
        if (r?.gte !== undefined) out.push(`${f.field}>=${r.gte}`);
        if (r?.lte !== undefined) out.push(`${f.field}<=${r.lte}`);
      }
    } else if ((c.kind === "prefix" || c.kind === "contains") && f.substring && [...c.value].length >= 3) {
      out.push(`${f.field}~${searchQuote(c.value)}`);
    }
  }
  return [...new Set(out)];
}

/**
 * Combine generated clauses with a caller-supplied query. Stripe Search has no
 * parentheses and cannot mix AND with OR, so a user query containing OR is sent alone
 * (the pushed filters are still applied exactly by the SDK).
 */
export function combineSearch(clauses: string[], userQuery?: string | null): string | undefined {
  const user = userQuery?.trim();
  if (user && /\sOR\s/.test(user)) return user;
  const all = user ? [user, ...clauses] : [...clauses];
  const userCount = user ? user.split(/\s+AND\s+/).length : 0;
  const room = Math.max(0, MAX_SEARCH_CLAUSES - userCount);
  const kept = user ? [user, ...clauses.slice(0, room)] : clauses.slice(0, MAX_SEARCH_CLAUSES);
  return all.length ? kept.join(" AND ") : undefined;
}
