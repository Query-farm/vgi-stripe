// Unit tests for the spec-driven layer (src/stripe/api.ts) and its generator.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { CATALOG } from "../src/catalog.ts";
import { ENDPOINTS, GENERATED, isDocumentedGet, rawParams, titleOf } from "../src/stripe/api.ts";
import { featureMessage } from "../src/stripe/client.ts";
import { planRequests, REDACTED, redactSecrets, type StripeTableSpec } from "../src/stripe/table.ts";

const ROOT = join(import.meta.dir, "..");

test("the committed generated layer matches the vendored spec (make generate)", () => {
  const p = Bun.spawnSync(["uv", "run", "--no-project", "python", "scripts/generate_api.py", "--check"], {
    cwd: ROOT,
    stderr: "pipe",
  });
  expect(p.stderr.toString()).not.toContain("out of date");
  expect(p.exitCode).toBe(0);
});

test("every GET endpoint of the spec is generated, folded into one, or excluded with a reason", async () => {
  const spec = JSON.parse(await Bun.file(join(ROOT, "spec/stripe-openapi/spec3.json")).text()) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const gets = Object.keys(spec.paths).filter((p) => spec.paths[p]?.get);
  const md = await Bun.file(join(ROOT, "src/stripe/generated/EXCLUDED.md")).text();
  for (const p of gets) expect(md).toContain(`| \`${p}\` |`);
  expect(gets.length).toBe(273);
});

test("generated schemas stay under vgi-lint's 50 objects per schema; names are unique", () => {
  const schemas = CATALOG.schemas ?? [];
  for (const s of schemas) expect((s.functions ?? []).length).toBeLessThanOrEqual(50);
  const names = ENDPOINTS.map((e) => `${e.schema}.${e.name}`);
  expect(new Set(names).size).toBe(names.length);
  expect(ENDPOINTS.length).toBeGreaterThanOrEqual(140);
});

test("no generated function exposes a credential field as a column or a pushed parameter", () => {
  const secret = new Set(["client_secret", "secret", "password", "payload", "cvc", "account_number"]);
  for (const e of ENDPOINTS) {
    for (const c of e.columns) expect(secret.has(c.n)).toBe(false);
    for (const p of e.params) expect(secret.has(p.p)).toBe(false);
  }
});

test("every result-columns schema fits vgi-lint's 4,000-character tag budget", () => {
  for (const s of CATALOG.schemas ?? []) {
    for (const f of s.functions ?? []) {
      const tag = f.meta.tags?.["vgi.result_columns_schema"] ?? "";
      expect(tag.length).toBeLessThan(4000);
    }
  }
});

test("redaction: global credential keys, object-scoped keys, nested and in lists", () => {
  const r = redactSecrets({
    object: "setup_intent",
    client_secret: "seti_x_secret_y",
    next_action: { redirect: { client_secret: "z" } },
    items: [{ object: "apps.secret", name: "n", payload: "p" }],
    number: "INV-1",
  }) as Record<string, unknown>;
  expect(r.client_secret).toBe(REDACTED);
  expect((r.next_action as { redirect: { client_secret: string } }).redirect.client_secret).toBe(REDACTED);
  expect((r.items as Record<string, unknown>[])[0]?.payload).toBe(REDACTED);
  expect((r.items as Record<string, unknown>[])[0]?.name).toBe("n");
  expect(r.number).toBe("INV-1"); // only an Issuing card's `number` is a PAN
  const card = redactSecrets({ object: "issuing.card", number: "4242424242424242", cvc: "123", last4: "4242" });
  expect(card).toEqual({ object: "issuing.card", number: REDACTED, cvc: REDACTED, last4: "4242" });
  const link = redactSecrets({ object: "file_link", url: "https://files.stripe.com/links/x", file: "file_1" });
  expect(link).toEqual({ object: "file_link", url: REDACTED, file: "file_1" });
});

test("feature-not-enabled and permission failures become clear messages", () => {
  expect(featureMessage("/v1/issuing/cards", 400, "Your account is not set up to use Issuing.")).toContain(
    "issuing is not enabled on this Stripe account",
  );
  expect(featureMessage("/v1/accounts", 400, "You can only use this API if you've signed up for Connect")).toContain(
    "accounts is not enabled",
  );
  expect(
    featureMessage("/v1/climate/orders", 403, "The provided key does not have the required permissions"),
  ).toContain("no read permission for climate");
  expect(
    featureMessage(
      "/v1/treasury/financial_accounts",
      400,
      "Unrecognized request URL (GET: /v1/treasury/financial_accounts)",
    ),
  ).toContain("treasury is not available on this Stripe account");
  expect(featureMessage("/v1/charges", 400, "Invalid integer: x")).toBeUndefined();
});

test("params := accepts only an endpoint's documented, unmanaged parameters", () => {
  const ep = { name: "fn", query_params: ["created", "relationship", "limit", "expand"] };
  expect(rawParams(ep, new Map([["relationship[owner]", "true"]]))).toEqual({ "relationship[owner]": "true" });
  expect(rawParams(ep, [{ key: "created[gte]", value: 5 }])).toEqual({ "created[gte]": "5" });
  expect(() => rawParams(ep, { colour: "red" })).toThrow(/not a documented parameter/);
  expect(() => rawParams(ep, { limit: "1" })).toThrow(/cannot set 'limit'/);
  expect(() => rawParams(ep, { "bad key": "1" })).toThrow(/not a Stripe parameter name/);
  expect(rawParams(ep, null)).toEqual({});
});

test("api.get accepts documented GET paths only", () => {
  expect(isDocumentedGet("/v1/charges/ch_123")).toBe(true);
  expect(isDocumentedGet("/v1/account")).toBe(true);
  expect(isDocumentedGet("/v1/customers/cus_1/tax_ids/txi_1")).toBe(true);
  expect(isDocumentedGet("/v1/charges/ch_1/capture")).toBe(false); // POST only
  expect(isDocumentedGet("/v1/quotes/qt_1/pdf")).toBe(false); // binary
  expect(isDocumentedGet("/v1/charges/../account")).toBe(false);
  expect(isDocumentedGet("/v1/charges/..")).toBe(false);
  expect(isDocumentedGet("/v2/core/events")).toBe(false);
  expect(GENERATED.get_paths.length).toBe(272);
});

test("titles name the product for namespaced schemas", () => {
  const cards = ENDPOINTS.find((e) => e.schema === "issuing" && e.name === "cards");
  expect(cards && titleOf(cards)).toBe("Issuing Cards");
  const tax = ENDPOINTS.find((e) => e.schema === "tax" && e.name === "tax_rates");
  expect(tax && titleOf(tax)).toBe("Tax Rates");
});

test("retrieve-by-id pushdown: one object GET per id, unless the list takes ids[]", () => {
  const spec = {
    name: "t",
    path: "/v1/charges",
    retrieve: "/v1/charges/{charge}",
    columns: [],
  } as unknown as StripeTableSpec<Record<string, unknown>>;
  const plan = planRequests(spec, {
    args: {},
    constraints: [{ kind: "in", column: "id", values: ["ch_b", "ch_a"] }],
  });
  expect(plan.map((p) => [p.path, p.mode, p.missingOk])).toEqual([
    ["/v1/charges/ch_a", "object", true],
    ["/v1/charges/ch_b", "object", true],
  ]);
  const withIds = { ...spec, params: { id: { param: "ids", kind: "string" as const, arrayOnly: true } } };
  const plan2 = planRequests(withIds, { args: {}, constraints: [{ kind: "in", column: "id", values: ["a", "b"] }] });
  expect(plan2).toEqual([{ path: "/v1/charges", query: { ids: ["a", "b"], limit: 100 }, mode: "list" }]);
});
