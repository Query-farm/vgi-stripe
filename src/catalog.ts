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
  CATALOG_COMMENT,
  CATALOG_NAME,
  CATALOG_TAGS,
  SCHEMA_DOC_MD,
  SCHEMA_TAGS,
  SOURCE_URL,
  STRIPE_API_VERSION,
} from "./meta.ts";
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

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [STRIPE_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_DOC_MD,
      functions: FUNCTIONS,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(ALL_EXAMPLES.slice(0, 12)) },
    },
  ],
};
