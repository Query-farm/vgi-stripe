// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  checkApiKey,
  configFromSecrets,
  encodeQuery,
  normalizeBaseUrl,
  retryDelayMs,
  type StripeConfig,
  shouldRetry,
  stripeGet,
} from "../src/stripe/client.ts";
import { currencyExponent, minorStringToDecimal, minorToDecimal } from "../src/stripe/money.ts";
import {
  type Constraint,
  combineSearch,
  type SearchField,
  searchClauses,
  searchQuote,
  secondsRange,
} from "../src/stripe/pushdown.ts";
import { balanceRows, FUNCTIONS, urlHost } from "../src/stripe/resources.ts";
import { asTime, C, idOf, planRequests, redactSecrets, type StripeTableSpec } from "../src/stripe/table.ts";

const ROOT = join(import.meta.dir, "..");
const S = (iso: string) => BigInt(Date.parse(iso)) * 1000n; // TIMESTAMPTZ literal (µs)

// ------------------------------------------------------------------ money

test("currency exponents follow Stripe (zero-, two- and three-decimal; ISK/HUF/TWD/UGX two)", () => {
  expect(currencyExponent("JPY")).toBe(0);
  expect(currencyExponent("krw")).toBe(0);
  expect(currencyExponent("kwd")).toBe(3);
  expect(currencyExponent("usd")).toBe(2);
  for (const c of ["isk", "huf", "twd", "ugx"]) expect(currencyExponent(c)).toBe(2);
});

test("minorToDecimal: unscaled DECIMAL(38,3) in the major unit", () => {
  expect(minorToDecimal(1234, "usd")).toBe(12340n); // 12.340
  expect(minorToDecimal(500, "jpy")).toBe(500000n); // 500.000
  expect(minorToDecimal(1500, "kwd")).toBe(1500n); // 1.500
  expect(minorToDecimal(-250, "eur")).toBe(-2500n);
  expect(minorToDecimal(null, "usd")).toBeNull();
  expect(minorToDecimal(10, null)).toBeNull();
  expect(minorToDecimal(1.5, "usd")).toBeNull();
});

test("minorStringToDecimal: sub-minor-unit unit prices at scale 12", () => {
  expect(minorStringToDecimal("0.25", "usd")).toBe(2_500_000_000n); // $0.0025
  expect(minorStringToDecimal("2900", "gbp")).toBe(29_000_000_000_000n); // £29
  expect(minorStringToDecimal("3000", "jpy")).toBe(3_000_000_000_000_000n); // ¥3000
  expect(minorStringToDecimal("-1.5", "usd")).toBe(-15_000_000_000n);
  expect(minorStringToDecimal("abc", "usd")).toBeNull();
});

// ---------------------------------------------------------------- pushdown

test("secondsRange: SQL bounds become exactly-equivalent whole-second gte/lte", () => {
  const cs: Constraint[] = [
    { kind: "cmp", column: "created", op: "gt", value: S("2026-11-03T00:00:00Z") },
    { kind: "cmp", column: "created", op: "lt", value: S("2026-11-06T00:00:00Z") },
  ];
  expect(secondsRange(cs, "created")).toEqual({ gte: 1793664001, lte: 1793923199 });
  // Fractional seconds: >= 10.5 s → gte 11; <= 10.5 s → lte 10.
  expect(secondsRange([{ kind: "cmp", column: "t", op: "ge", value: 10_500_000n }], "t")).toEqual({ gte: 11 });
  expect(secondsRange([{ kind: "cmp", column: "t", op: "le", value: 10_500_000n }], "t")).toEqual({ lte: 10 });
  expect(secondsRange([{ kind: "cmp", column: "t", op: "eq", value: 10_000_000n }], "t")).toEqual({ gte: 10, lte: 10 });
  expect(secondsRange(cs, "other")).toBeUndefined();
});

test("searchQuote escapes backslashes and quotes", () => {
  expect(searchQuote('O"Brien \\ Co')).toBe('"O\\"Brien \\\\ Co"');
});

const FIELDS: Record<string, SearchField> = {
  status: { field: "status", kind: "string" },
  amount: { field: "amount", kind: "number" },
  created: { field: "created", kind: "time" },
  refunded: { field: "refunded", kind: "bool" },
  name: { field: "name", kind: "string", substring: true },
};

test("searchClauses: one clause per translatable constraint", () => {
  const cs: Constraint[] = [
    { kind: "cmp", column: "status", op: "eq", value: "failed" },
    { kind: "cmp", column: "amount", op: "ge", value: 1000n },
    { kind: "cmp", column: "created", op: "lt", value: S("2026-11-02T00:00:00Z") },
    { kind: "cmp", column: "refunded", op: "eq", value: true },
    { kind: "prefix", column: "name", value: "Ada" },
    { kind: "prefix", column: "name", value: "Ad" }, // too short for ~
    { kind: "cmp", column: "status", op: "gt", value: "a" }, // strings: equality only
    { kind: "in", column: "status", values: ["a", "b"] }, // split by the caller
  ];
  expect(searchClauses(cs, FIELDS)).toEqual([
    'status:"failed"',
    "amount>=1000",
    "created<=1793577599",
    'refunded:"true"',
    'name~"Ada"',
  ]);
});

test("combineSearch: AND with the user's query, never mixing OR, at most 10 clauses", () => {
  expect(combineSearch(['status:"paid"'], 'metadata["k"]:"v"')).toBe('metadata["k"]:"v" AND status:"paid"');
  expect(combineSearch(['status:"paid"'], 'number:"A" OR number:"B"')).toBe('number:"A" OR number:"B"');
  expect(combineSearch([], null)).toBeUndefined();
  const many = Array.from({ length: 12 }, (_, i) => `amount>${i}`);
  expect(combineSearch(many)?.split(" AND ").length).toBe(10);
});

// -------------------------------------------------------- request planning

const SPEC: StripeTableSpec<Record<string, never>> = {
  name: "t",
  description: "",
  title: "",
  category: "payments",
  keywords: "",
  docLlm: "",
  docMd: "",
  pushdown: "",
  examples: [],
  path: "/v1/charges",
  columns: [C.id("id")],
  params: {
    customer: { param: "customer", kind: "string" },
    payment_intent: { param: "payment_intent", kind: "string" },
    state: { param: "status", kind: "string", choices: ["a", "b"] },
    ids: { param: "ids", kind: "string", arrayOnly: true },
  },
  ranges: { created: "created" },
  search: { path: "/v1/charges/search", fields: { ...FIELDS, customer: { field: "customer", kind: "string" } } },
};
const plan = (constraints: Constraint[], search: string | null = null) =>
  planRequests(SPEC as never, { args: { search } as never, constraints });

test("planRequests: list parameters when the list API can express every filter", () => {
  const r = plan([
    { kind: "cmp", column: "customer", op: "eq", value: "cus_1" },
    { kind: "cmp", column: "created", op: "ge", value: S("2026-11-01T00:00:00Z") },
  ]);
  expect(r).toEqual([
    { path: "/v1/charges", query: { customer: "cus_1", created: { gte: 1793491200 }, limit: 100 }, mode: "list" },
  ]);
});

test("planRequests: IN splits into one request per value; arrays stay one request", () => {
  const r = plan([{ kind: "in", column: "customer", values: ["b", "a"] }]);
  expect(r.map((p) => p.query.customer)).toEqual(["b", "a"]);
  const ids = plan([{ kind: "in", column: "ids", values: ["y", "x"] }]);
  expect(ids).toHaveLength(1);
  expect(ids[0]?.query.ids).toEqual(["x", "y"]);
});

test("planRequests: an impossible enum value or empty range sends nothing", () => {
  expect(plan([{ kind: "cmp", column: "state", op: "eq", value: "zzz" }])).toEqual([]);
  expect(
    plan([
      { kind: "cmp", column: "created", op: "gt", value: S("2026-11-05T00:00:00Z") },
      { kind: "cmp", column: "created", op: "lt", value: S("2026-11-04T00:00:00Z") },
    ]),
  ).toEqual([]);
});

test("planRequests: a search-only filter switches to Search, with list-expressible ones folded in", () => {
  const r = plan([
    { kind: "cmp", column: "status", op: "eq", value: "failed" },
    { kind: "cmp", column: "customer", op: "eq", value: "cus_1" },
  ]);
  expect(r).toEqual([
    {
      path: "/v1/charges/search",
      query: { query: 'status:"failed" AND customer:"cus_1"', limit: 100 },
      mode: "search",
    },
  ]);
});

test("planRequests: a list-only filter keeps the consistent list API", () => {
  const r = plan([
    { kind: "cmp", column: "status", op: "eq", value: "failed" },
    { kind: "cmp", column: "payment_intent", op: "eq", value: "pi_1" },
  ]);
  expect(r[0]?.mode).toBe("list");
  expect(r[0]?.query.payment_intent).toBe("pi_1");
});

test("planRequests: IN on a search field becomes one Search query per value", () => {
  const r = plan([{ kind: "in", column: "status", values: ["a", "b"] }]);
  expect(r.map((p) => p.query.query)).toEqual(['status:"a"', 'status:"b"']);
});

test("planRequests: search := forces Search", () => {
  const r = plan([], 'metadata["k"]:"v"');
  expect(r[0]?.mode).toBe("search");
  expect(r[0]?.query.query).toBe('metadata["k"]:"v"');
});

// ------------------------------------------------------------------ helpers

test("idOf / asTime / redactSecrets / urlHost / balanceRows", () => {
  expect(idOf("cus_1")).toBe("cus_1");
  expect(idOf({ id: "cus_2", object: "customer" })).toBe("cus_2");
  expect(idOf(null)).toBeNull();
  expect(asTime(1793491200)).toBe(1793491200000000n);
  expect(redactSecrets({ a: { client_secret: "x", secret: null, b: [{ secret: "y" }] }, __ctx: {} })).toEqual({
    a: { client_secret: "[redacted]", secret: null, b: [{ secret: "[redacted]" }] },
  });
  expect(urlHost("https://hooks.example.com:8443/x?token=1")).toBe("hooks.example.com:8443");
  expect(urlHost("not a url")).toBeNull();
  const rows = balanceRows({ available: [{ amount: 1, currency: "usd" }], pending: [], issuing: { available: [] } });
  expect(rows).toEqual([{ amount: 1, currency: "usd", bucket: "available", livemode: undefined }]);
});

test("every function has a description, title, category, examples and documented columns", () => {
  expect(FUNCTIONS.length).toBe(31);
  for (const fn of FUNCTIONS) {
    expect(fn.meta.description?.length ?? 0).toBeGreaterThan(10);
    expect(fn.meta.tags?.["vgi.category"]).toBeTruthy();
    expect((fn.meta.examples ?? []).length).toBeGreaterThan(0);
    const cols = JSON.parse(fn.meta.tags?.["vgi.result_columns_schema"] ?? "[]") as { description: string }[];
    for (const c of cols) expect(c.description.length).toBeGreaterThan(3);
  }
});

// ------------------------------------------------------------------- client

test("encodeQuery: Stripe's bracketed form parameters", () => {
  expect(
    decodeURIComponent(
      encodeQuery({ limit: 100, created: { gte: 1, lt: 2 }, expand: ["data.customer"], skip: undefined, empty: "" }),
    ),
  ).toBe("limit=100&created[gte]=1&created[lt]=2&expand[]=data.customer");
});

test("API keys: restricted or secret only; base_url https except loopback", () => {
  expect(() => checkApiKey("pk_live_abc")).toThrow(/publishable/);
  expect(() => checkApiKey("whsec_abc")).toThrow(/restricted/);
  expect(() => checkApiKey("rk_live_abc")).not.toThrow();
  expect(normalizeBaseUrl("https://api.stripe.com/")).toBe("https://api.stripe.com");
  expect(normalizeBaseUrl("http://127.0.0.1:9999")).toBe("http://127.0.0.1:9999");
  expect(() => normalizeBaseUrl("http://api.stripe.com")).toThrow(/https/);
});

test("configFromSecrets: defaults, Connect override and validation", () => {
  expect(() => configFromSecrets({})).toThrow(/no stripe secret/);
  const base = { type: "stripe", api_key: "rk_test_x" };
  const cfg = configFromSecrets({ s: base });
  expect(cfg.baseUrl).toBe("https://api.stripe.com");
  expect(cfg.apiVersion).toMatch(/^\d{4}-\d{2}-\d{2}\./);
  expect(cfg.stripeAccount).toBeUndefined();
  expect(configFromSecrets({ s: { ...base, stripe_account: "acct_1" } }, "acct_2").stripeAccount).toBe("acct_2");
  expect(() => configFromSecrets({ s: base }, "bad")).toThrow(/acct_/);
  expect(() => configFromSecrets({ s: { ...base, api_version: "latest" } })).toThrow(/api_version/);
});

test("retries: Stripe-Should-Retry overrides the status rule; Retry-After is honoured", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  expect(shouldRetry(429, h({}))).toBe(true);
  expect(shouldRetry(409, h({}))).toBe(true);
  expect(shouldRetry(503, h({ "Stripe-Should-Retry": "false" }))).toBe(false);
  expect(shouldRetry(400, h({ "Stripe-Should-Retry": "true" }))).toBe(true);
  expect(shouldRetry(400, h({}))).toBe(false);
  expect(retryDelayMs(h({ "Retry-After": "2" }), 1)).toBe(2000);
  expect(retryDelayMs(h({}), 1, 0.5)).toBe(500);
  expect(retryDelayMs(h({}), 3, 0.5)).toBe(2000);
  expect(retryDelayMs(h({}), 20, 0.5)).toBe(30_000);
});

describe("against the replay server", () => {
  let mock: ReturnType<typeof Bun.spawn>;
  let cfg: StripeConfig;

  beforeAll(async () => {
    mock = Bun.spawn([process.env.PYTHON ?? "python3", join(ROOT, "test", "mock_api", "server.py")], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const port = text.match(/^PORT:(\d+)/)?.[1];
    if (!port) throw new Error(`replay server did not report a port: ${text}`);
    cfg = configFromSecrets({
      s: { type: "stripe", api_key: "rk_test_fixture", base_url: `http://127.0.0.1:${port}` },
    });
  });

  afterAll(() => {
    mock?.kill();
  });

  test("a 429 with Stripe-Should-Retry: true is retried", async () => {
    const body = (await stripeGet(cfg, "/v1/disputes", { limit: 100 })) as { data: unknown[] };
    expect(body.data.length).toBe(2);
  });

  test("a 503 with Stripe-Should-Retry: false is not", async () => {
    await expect(stripeGet(cfg, "/v1/files", { limit: 100 })).rejects.toThrow(/HTTP 503/);
    const body = (await stripeGet(cfg, "/v1/files", { limit: 100 })) as { data: unknown[] };
    expect(body.data.length).toBe(3);
  });

  test("Stripe's error envelope is summarised with the HTTP status", async () => {
    await expect(stripeGet(cfg, "/v1/charges", { bogus: "1" })).rejects.toThrow(
      /HTTP 400: invalid_request_error parameter_unknown Received unknown parameter: bogus/,
    );
    await expect(stripeGet({ ...cfg, apiKey: "rk_test_nope" }, "/v1/charges")).rejects.toThrow(/HTTP 401/);
  });
});
