/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "stripe";
export const VERSION = "0.2.1";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-stripe";

/**
 * The Stripe API version sent as `Stripe-Version` unless the secret pins another
 * (column extraction also reads the older field locations, so older pins work).
 * It is the version of the OpenAPI spec the fixtures were checked against.
 */
export const STRIPE_API_VERSION = "2026-09-30.endive";

/** Categories group functions in docs and agent tools. Every object's `vgi.category` names one. */
export const SCHEMA_CATEGORIES = [
  {
    name: "payments",
    title: "Payments",
    description: "Charges, PaymentIntents, refunds, disputes, payment methods, Checkout Sessions and Radar warnings.",
  },
  {
    name: "balance",
    title: "Balance & Payouts",
    description: "The account balance, balance transactions and payouts.",
  },
  { name: "customers", title: "Customers", description: "Customers and their saved payment methods." },
  {
    name: "billing",
    title: "Billing",
    description:
      "Invoices and their lines, invoice items, subscriptions and their items, subscription schedules, credit notes, meters.",
  },
  {
    name: "product_catalog",
    title: "Product Catalog",
    description: "Products, prices, coupons, promotion codes and tax rates.",
  },
  { name: "connect", title: "Connect", description: "Connected accounts, application fees and transfers." },
  {
    name: "platform",
    title: "Events & Platform",
    description: "The event (change) feed, webhook endpoints and files.",
  },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category | string;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const SOURCES_MD =
  "### Sources and references\n\n" +
  "- [Stripe API reference](https://docs.stripe.com/api) — the endpoints this worker reads\n" +
  "- [Pagination](https://docs.stripe.com/api/pagination) and [Search](https://docs.stripe.com/search) (query language, eventual consistency)\n" +
  "- [Expanding responses](https://docs.stripe.com/expand) and [API versioning](https://docs.stripe.com/api/versioning)\n" +
  "- [Restricted API keys](https://docs.stripe.com/keys#limit-access) and [rate limits](https://docs.stripe.com/rate-limits)\n" +
  "- [Currencies and minor units](https://docs.stripe.com/currencies#minor-units)\n" +
  "- [stripe/openapi](https://github.com/stripe/openapi) — the spec the test fixtures are checked against";

export const CATALOG_COMMENT =
  "Stripe as SQL: payments, balance, customers, billing, product catalog, Connect and the event feed, read-only from the Stripe API.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to a Stripe account through the Stripe REST API. Reach for it to analyse payments " +
  "(charges, PaymentIntents, refunds, disputes, Radar early fraud warnings, Checkout Sessions), money movement " +
  "(balance, balance transactions with fees and net, payouts), customers and their card payment methods (brand, " +
  "last4, expiry only), billing (invoices and line items, invoice items, subscriptions and items, schedules, " +
  "credit notes, billing meters and usage summaries), the product catalog (products, prices, coupons, promotion " +
  "codes, tax rates), Connect (accounts, application fees, transfers) and the event change feed (last 30 days). " +
  "Every function is a table function in stripe.main and needs a `stripe` DuckDB secret: CREATE SECRET (TYPE " +
  "stripe, API_KEY 'rk_live_…') — a restricted key with read permissions is recommended; STRIPE_ACCOUNT reads " +
  "a Connect account, API_VERSION pins Stripe-Version. Amounts are integers in the currency's minor unit " +
  "(`amount` `BIGINT`, cents for USD, yen for JPY) with an exact `amount_decimal` `DECIMAL(38,3)` in the major unit; " +
  "timestamps are `TIMESTAMPTZ`; metadata is `MAP(VARCHAR, VARCHAR)`; `raw` holds the whole object as `JSON`. WHERE " +
  "filters on created (and other time) ranges, ids such as customer / subscription / payment_intent, status and " +
  "type push down as list parameters; filters the list API lacks (charge status, amount, customer name, product " +
  "name …) switch to the eventually consistent Search API; `search := ` takes a raw Stripe search query (e.g. " +
  "metadata). Beyond these curated functions in stripe.main, one schema per Stripe product area holds a generated " +
  "table function for every documented GET endpoint (Issuing, Treasury, Terminal, Identity, Tax, Climate, " +
  "Financial Connections, reporting and Sigma scheduled query runs, …), and stripe.api.get(path) returns any single " +
  "object as JSON. Sigma queries themselves cannot be run through the API, but their scheduled runs (and result " +
  "files) can be listed. Docs: https://docs.stripe.com/api ; search syntax " +
  "https://docs.stripe.com/search#search-query-language .";

export const CATALOG_DOC_MD =
  "# Stripe\n\n" +
  "Query a Stripe account from DuckDB: charges, PaymentIntents, refunds, disputes, balance transactions, payouts, " +
  "customers, invoices, subscriptions, the product catalog, Connect transfers and the event feed. Read-only.\n\n" +
  "Create a `stripe` secret with an API key — a **restricted key** with read permissions is recommended. Filters " +
  "on time ranges, ids, status and type become Stripe list parameters; filters only Stripe Search understands " +
  "use the Search API. Amounts come both as Stripe's minor-unit integers and as exact decimals. Pagination, " +
  "rate limits (429 + `Stripe-Should-Retry`) and Connect (`Stripe-Account`) are handled for you.\n\n" +
  "### Every endpoint\n\nThe curated `main` schema covers everyday analysis. For everything else, one schema per " +
  "Stripe product area is generated from Stripe's OpenAPI spec with a table function for every read endpoint, " +
  "nested lists included, and `api.get(path)` returns any single object as raw JSON. Sigma's scheduled query runs " +
  "are listed there (running Sigma SQL is not part of the API). Products not enabled on the account answer with a " +
  'clear "not enabled" error.\n\n' +
  SOURCES_MD;

export const SCHEMA_DOC_LLM =
  "Stripe API collections as table functions, one per list endpoint (stripe.main.charges(), customers(), " +
  "invoices(), …). Every function takes the named arguments stripe_account := (read a Connect account) and " +
  "expand := [...] (raw Stripe expand paths into the raw JSON column); searchable resources (charges, " +
  "customers, invoices, payment_intents, prices, products, subscriptions) also take search := (a Stripe " +
  "search query). Child collections (invoice_line_items, subscription_items, payment_methods) take the parent " +
  "id as a named argument or a pushed `= / IN` filter, and otherwise read every parent. All need a `stripe` secret.";

export const SCHEMA_COMMENT =
  "Curated Stripe tables for everyday analysis: payments, balance and payouts, customers, billing, the product " +
  "catalog, Connect and the event feed.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "The hand-tuned Stripe functions: one table function per core list endpoint, with money as `BIGINT` minor " +
  "units plus exact `*_decimal` amounts, Unix times as `TIMESTAMPTZ` and metadata as a `MAP`.\n\n" +
  "### Arguments\n\n" +
  "Every function takes `stripe_account :=` (read a Connect account) and `expand := [...]` (Stripe expand paths " +
  "into the `raw` JSON column). Searchable resources (charges, customers, invoices, payment_intents, prices, " +
  "products, subscriptions) also take `search :=`, a Stripe search query.\n\n" +
  "### Pushdown\n\n" +
  "`created`-style time ranges, ids, status and type filters are sent to Stripe; other filters run in DuckDB. " +
  "Child collections (invoice_line_items, subscription_items, payment_methods) take the parent id as a named " +
  "argument or a pushed `= / IN` filter, and otherwise read every parent (one request each).\n\n" +
  "### Credentials\n\n" +
  "All functions need a `stripe` secret holding an API key; a restricted `rk_...` read-only key is enough. " +
  "For endpoints not covered here, use the generated schemas or `stripe.api.get`.";

export const AGENT_TEST_TASKS = [
  {
    name: "gross_volume_by_currency",
    prompt: "What is the total amount of succeeded charges per currency, in major units?",
  },
  { name: "failed_charges", prompt: "Which charges failed, and with what failure code?" },
  { name: "refund_total", prompt: "How much has been refunded in total per currency (major units)?" },
  { name: "open_disputes", prompt: "Which disputes still need a response, and how much is at stake?" },
  { name: "fees_by_type", prompt: "What are the total Stripe fees per balance transaction type in USD (major units)?" },
  { name: "paid_payouts", prompt: "List the paid payouts and their arrival dates." },
  { name: "customer_lookup", prompt: "What is the customer id and name for ada@example.com?" },
  { name: "expiring_cards", prompt: "Which customers have a saved card that expires in 2026 or earlier?" },
  { name: "open_invoices", prompt: "Which invoices are open, and how much is still due on each?" },
  { name: "active_subscriptions", prompt: "How many subscriptions are active or trialing?" },
  { name: "mrr_prices", prompt: "Which recurring monthly prices exist, with their product names?" },
  { name: "event_types", prompt: "How many events of each type does the event feed contain?" },
  { name: "connect_transfers", prompt: "How much was transferred to each connected account?" },
  {
    name: "available_balance",
    prompt: "How much money is available in the Stripe balance per currency, in major units?",
  },
  { name: "abandoned_intents", prompt: "Which PaymentIntents were canceled, and why?" },
  { name: "fraud_warnings", prompt: "Which charges have an actionable Radar early fraud warning?" },
  { name: "checkout_conversion", prompt: "How many Checkout Sessions are complete, expired and open?" },
  { name: "invoice_line_products", prompt: "How much has been invoiced per product (major units, per currency)?" },
  { name: "pending_invoice_items", prompt: "Which invoice items are still pending (not on an invoice yet)?" },
  {
    name: "seat_counts",
    prompt: "How many seats (quantity) does each subscription have on the Basic Plan monthly price?",
  },
  { name: "schedule_status", prompt: "Which subscription schedules have not started yet?" },
  { name: "issued_credit_notes", prompt: "What credit notes have been issued, for which invoices and amounts?" },
  { name: "active_meters", prompt: "Which billing meters are active and what event names do they count?" },
  {
    name: "daily_api_usage",
    prompt:
      "How many API calls did customer cus_margaret make per day between 2026-11-01 and 2026-11-04 (meter mtr_api_calls)?",
  },
  { name: "valid_coupons", prompt: "Which coupons are still valid, and how often has each been redeemed?" },
  { name: "active_promo_codes", prompt: "Which promotion codes are active, and for which coupon?" },
  { name: "inclusive_tax_rates", prompt: "Which active tax rates are inclusive?" },
  { name: "unpayable_accounts", prompt: "Which connected accounts cannot receive payouts yet?" },
  {
    name: "platform_fees",
    prompt: "What net application fees (after refunds) did the platform earn per connected account?",
  },
  { name: "webhook_hosts", prompt: "Which hosts receive Stripe webhooks, and are they enabled?" },
  { name: "dispute_evidence_files", prompt: "Which files were uploaded as dispute evidence?" },
  {
    name: "raw_account_object",
    prompt: "Using the raw Stripe API response for /v1/account, what object type does Stripe report?",
  },
];

/** Bind-only probes: each binds the function and shows its columns without fetching (LIMIT 0). */
export const EXECUTABLE_EXAMPLES = [
  {
    name: "charges_columns",
    description: "The charges() result columns (binds only; create a stripe secret and drop LIMIT 0 for rows)",
    sql: "SELECT id, amount, amount_decimal, currency, status, created FROM stripe.main.charges() LIMIT 0",
  },
  {
    name: "balance_transactions_columns",
    description:
      "The balance_transactions() result columns (binds only; create a stripe secret and drop LIMIT 0 for rows)",
    sql: "SELECT id, type, amount, fee, net, available_on FROM stripe.main.balance_transactions() LIMIT 0",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Stripe Payments & Billing",
  "vgi.subtitle": "Stripe payments, billing, customers, payouts, Connect and events as SQL tables.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "stripe, payments, charges, payment intents, refunds, disputes, payouts, balance, customers, invoices, subscriptions, billing, connect, events, finance, revenue",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
  "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Stripe API",
  domain: "payments",
  "vgi.keywords": keywordsArray(
    "stripe, charges, customers, invoices, subscriptions, payouts, balance transactions, events",
  ),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};
