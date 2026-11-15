/**
 * Assemble the `stripe` catalog: the table functions and the `stripe` secret type.
 */

import {
  type CatalogDescriptor,
  field,
  type SecretTypeDescriptor,
  schema,
  utf8,
  type VgiFunction,
} from "@query-farm/vgi";
import {
  AGENT_TEST_TASKS,
  CATALOG_COMMENT,
  CATALOG_NAME,
  CATALOG_TAGS,
  keywordsArray,
  SCHEMA_COMMENT,
  SCHEMA_TAGS,
  SOURCE_URL,
  STRIPE_API_VERSION,
} from "./meta.ts";
import { apiGet, GENERATED, generatedSchemas } from "./stripe/api.ts";
import { SECRET_TYPE } from "./stripe/client.ts";
import { FUNCTIONS } from "./stripe/resources.ts";

export { FUNCTIONS };

const doc = (text: string) => new Map([["vgi_doc", text]]);

/** CREATE SECRET (TYPE stripe, API_KEY 'rk_live_…' [, STRIPE_ACCOUNT, API_VERSION, BASE_URL]). */
export const STRIPE_SECRET_TYPE: SecretTypeDescriptor = {
  name: SECRET_TYPE,
  description:
    "Stripe API key (restricted key with read permissions recommended), plus optional Connect account and API version",
  schema: schema(
    [
      field(
        "api_key",
        utf8(),
        true,
        new Map([
          ["redact", "true"],
          [
            "vgi_doc",
            "Stripe API key: a restricted key (rk_live_… / rk_test_…) with read permissions is recommended; a secret key (sk_…) also works but can write.",
          ],
        ]),
      ),
      field(
        "stripe_account",
        utf8(),
        true,
        doc("Connect: read this connected account (acct_…) via the Stripe-Account header."),
      ),
      field("api_version", utf8(), true, doc(`Stripe-Version to send (default ${STRIPE_API_VERSION}).`)),
      field(
        "base_url",
        utf8(),
        true,
        doc(
          "API base URL (default https://api.stripe.com); http:// is accepted only for 127.0.0.1/localhost fixtures.",
        ),
      ),
    ],
    new Map([["vgi_doc_url", "https://docs.stripe.com/keys#limit-access"]]),
  ),
};

interface Example {
  description: string;
  sql: string;
}

/** Publish each function's examples as `vgi.example_queries`; return them all for the schema. */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const all: Example[] = [];
  for (const fn of functions) {
    const ex = (fn.meta.examples ?? []).map((e) => ({ description: e.description, sql: e.sql }));
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(ex) };
    all.push(...ex);
  }
  return all;
}

const ALL_EXAMPLES = stampExampleQueries(FUNCTIONS);

const SPEC_NOTE =
  `Generated from Stripe's OpenAPI spec (API ${GENERATED.spec.api_version}, stripe/openapi ${GENERATED.spec.commit.slice(0, 12)}), ` +
  "one table function per GET endpoint.";

/** The spec-driven schemas (payments, billing, issuing, …): every Stripe GET endpoint. */
const GENERATED_SCHEMAS = generatedSchemas().map((g) => {
  const examples = stampExampleQueries(g.functions);
  const families = g.desc.categories.map((c) => c.title.toLowerCase()).join(", ");
  const docLlm =
    `${g.desc.description} ${SPEC_NOTE} Columns use Stripe's field names (ids for expandable references, ` +
    "`TIMESTAMPTZ` for Unix times, `BIGINT` minor units plus exact `*_decimal` amounts, `MAP` metadata, `JSON` for " +
    "deeper objects, `raw` with credentials redacted). Documented list parameters push down: equality / IN on ids, " +
    "status and type, boolean flags, `created`-style time ranges, `ids[]`, and `id = …` becomes a retrieve. Other " +
    "query parameters are named arguments, and `params := MAP {…}` passes any documented one. Nested lists take the " +
    "parent id as a named argument or a pushed `= / IN` filter, or fan out over every parent (one request per " +
    "parent). For everyday analysis prefer the curated functions in stripe.main. All need a `stripe` secret.";
  const docMd =
    `## ${g.name}\n\n${g.desc.description}\n\n` +
    `${SPEC_NOTE} Families covered: ${families}.\n\n` +
    "### Pushdown\n\nList parameters, time ranges and retrieve-by-id are pushed to Stripe; every other filter runs " +
    "in DuckDB. Nested lists fan out over their parent unless you name the parent.\n\n" +
    "### Credentials\n\nAll functions need a `stripe` secret; secrets in responses are redacted.";
  return {
    path: [g.name],
    comment: g.desc.description,
    functions: g.functions,
    tags: {
      "vgi.title": g.desc.title,
      domain: "payments",
      "vgi.keywords": JSON.stringify([
        ...new Set(JSON.parse(keywordsArray(`stripe, ${g.name.replace(/_/g, " ")}, api, ${families}`)) as string[]),
      ]),
      "vgi.doc_llm": docLlm,
      "vgi.doc_md": docMd,
      "vgi.categories": JSON.stringify(g.desc.categories),
      "vgi.example_queries": JSON.stringify(examples.slice(0, 10)),
    },
  };
});

const API_EXAMPLES = stampExampleQueries([apiGet]);

const API_SCHEMA = {
  path: ["api"],
  comment:
    "Raw JSON access to any documented Stripe GET endpoint, for single objects and fields the typed functions omit.",
  functions: [apiGet],
  tags: {
    "vgi.title": "Stripe Raw API",
    domain: "payments",
    "vgi.keywords": keywordsArray("stripe, raw api, json, get, retrieve by id, escape hatch"),
    "vgi.doc_llm":
      "One escape-hatch function returning a Stripe GET response as a JSON row. The path must match a GET in " +
      "Stripe's OpenAPI spec (so nothing can be written); ids are filled into the path. Credentials in the response " +
      "are redacted. Use the typed schemas for lists and analysis; use this for one object by id or verbatim fields.",
    "vgi.doc_md":
      "## api\n\nRaw GET access to the Stripe API for single objects by id and for fields the typed functions do " +
      "not flatten.\n\n### Safety\n\nOnly paths that match a GET in the vendored OpenAPI spec are accepted, so " +
      "nothing can be written; credentials are redacted from responses.\n\n### When to use\n\nReach for the " +
      "typed schemas first; use this for one object or a verbatim field.",
    "vgi.categories": JSON.stringify([
      { name: "raw", title: "Raw API", description: "Any documented Stripe GET endpoint as JSON." },
    ]),
    "vgi.example_queries": JSON.stringify(API_EXAMPLES),
  },
};

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: {
    ...CATALOG_TAGS,
    // Curated tasks plus one per generated function (graders: the generated block of vgi-agent-tests.yaml).
    "vgi.agent_test_tasks": JSON.stringify([
      ...AGENT_TEST_TASKS,
      ...GENERATED.endpoints.map((e) => ({ name: e.task.name, prompt: e.task.prompt })),
    ]),
  },
  secretTypes: [STRIPE_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_COMMENT,
      functions: FUNCTIONS,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(ALL_EXAMPLES.slice(0, 12)) },
    },
    ...GENERATED_SCHEMAS,
    API_SCHEMA,
  ],
};
