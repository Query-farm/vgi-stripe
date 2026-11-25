<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query Stripe Payments, Billing, Payouts and Events in DuckDB

> **vgi-stripe** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-stripe/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-stripe/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

Stripe as SQL, read-only, through the [Stripe REST API](https://docs.stripe.com/api):
charges and PaymentIntents, refunds and disputes, the balance ledger and payouts,
customers and their cards, invoices and subscriptions, the product catalog, Connect,
and the event feed. Amounts come both as Stripe's minor-unit integers and as exact
decimals in the currency's major unit.

It is a **complete read-only integration**: 31 hand-written functions in `stripe.main`
for everyday analysis, plus a layer generated from Stripe's OpenAPI spec with a table
function for **every GET endpoint** — Issuing, Treasury, Terminal, Identity, Tax, Climate,
Financial Connections, Billing (credit grants, meters, entitlements, quotes, portal),
Radar, reporting and Sigma scheduled query runs, nested lists such as a customer's tax
ids or a transfer's reversals — and `stripe.api.get(path)` for any single object as JSON.

```sql
CREATE SECRET stripe (TYPE stripe, API_KEY 'rk_live_…');   -- a restricted, read-only key

-- Net revenue after Stripe fees, by currency, this month (created range pushed down;
-- projecting fee/net expands each charge's balance transaction in the same requests).
SELECT currency, sum(amount_decimal) AS gross, sum(fee_decimal) AS fees, sum(net_decimal) AS net
FROM stripe.main.charges()
WHERE status = 'succeeded' AND created >= date_trunc('month', now())
GROUP BY currency ORDER BY gross DESC;

-- What was in a payout?
SELECT type, sum(net_decimal) AS net
FROM stripe.main.balance_transactions(payout := 'po_1QxY…')
GROUP BY type;

-- Who is churning? (every status, canceled included)
SELECT cancellation_reason, count(*) FROM stripe.main.subscriptions()
WHERE status = 'canceled' AND canceled_at >= now() - INTERVAL 30 DAY GROUP BY ALL;
```

## Curated functions (`stripe.main`)

The recommended entry points. All are table functions in `stripe.main`. Every function also takes
`stripe_account := 'acct_…'` (read a Connect account) and `expand := ['customer', …]`
(raw Stripe expansions, returned in the `raw` JSON column). The searchable resources
(charges, customers, invoices, payment_intents, prices, products, subscriptions) take
`search := '…'`, a raw [Stripe Search](https://docs.stripe.com/search#search-query-language)
query ANDed with the pushed filters — the way to filter on metadata:
`charges(search := 'metadata["order_id"]:"6735"')`.

| Function | Stripe endpoint | What pushes down |
|---|---|---|
| `balance()` | `GET /v1/balance` | — (one row per bucket × currency) |
| `balance_transactions(payout := NULL)` | `/v1/balance_transactions` | `created` range; `type`, `source`, `currency`; `payout :=`. `available_on` is filtered locally (no list parameter) |
| `payouts()` | `/v1/payouts` | `created`, `arrival_date` ranges; `status`, `destination` |
| `charges(search := NULL)` | `/v1/charges` · `/search` | `created`; `customer`, `payment_intent`, `transfer_group` → list. `status`, `amount` (`= < > …`), `currency`, `refunded`, `disputed`, `card_last4`, `billing_postal_code` → Search |
| `payment_intents(search := NULL)` | `/v1/payment_intents` · `/search` | `created`, `customer` → list; `status`, `amount`, `currency` → Search |
| `refunds()` | `/v1/refunds` | `created`; `charge`, `payment_intent` |
| `disputes()` | `/v1/disputes` | `created`; `charge`, `payment_intent` |
| `early_fraud_warnings()` | `/v1/radar/early_fraud_warnings` | `created`; `charge`, `payment_intent` |
| `checkout_sessions()` | `/v1/checkout/sessions` | `created`; `customer`, `status`, `payment_intent`, `payment_link`, `subscription`, `customer_email` → `customer_details[email]` |
| `customers(search := NULL)` | `/v1/customers` · `/search` | `created`, `email` (exact), `test_clock` → list; `name`, `phone`, `starts_with`/`contains` on `name`/`email` → Search (`~`) |
| `payment_methods(customer_id := NULL)` | `/v1/customers/{id}/payment_methods` | `customer` (`=`/`IN`) or `customer_id :=`, else every customer; `type`. Card brand / last4 / expiry / funding / country / wallet only |
| `invoices(search := NULL)` | `/v1/invoices` · `/search` | `created`, `due_date`; `customer`, `status`, `subscription`, `collection_method` → list; `number`, `total`, `currency`, `receipt_number` → Search |
| `invoice_line_items(invoice_id := NULL)` | `/v1/invoices/{id}/lines` | `invoice_id` (`=`/`IN`) or `invoice_id :=`; otherwise every invoice's embedded lines (a call only when an invoice has more) |
| `invoice_items()` | `/v1/invoiceitems` | `date` → `created[…]`; `customer`, `invoice`, `pending` |
| `subscriptions(search := NULL)` | `/v1/subscriptions` | `created`, `current_period_start/end`; `customer`, `status` (else `status=all`), `collection_method`, `test_clock` |
| `subscription_items(subscription_id := NULL)` | `/v1/subscription_items` | `subscription_id` (`=`/`IN`) or argument; otherwise every subscription's embedded items |
| `subscription_schedules()` | `/v1/subscription_schedules` | `created`, `canceled_at`, `completed_at`, `released_at`; `customer` |
| `credit_notes()` | `/v1/credit_notes` | `created`; `customer`, `invoice` |
| `billing_meters()` | `/v1/billing/meters` | `status` |
| `meter_event_summaries(meter_id, customer, start_time, end_time, value_grouping_window := NULL)` | `/v1/billing/meters/{id}/event_summaries` | the arguments (Stripe requires minute / hour / day alignment) |
| `products(search := NULL)` | `/v1/products` · `/search` | `created`; `id` (`IN` → `ids[]`), `active`, `shippable`, `url` → list; `name`, `description` → Search |
| `prices(search := NULL)` | `/v1/prices` | `created`; `active`, `currency`, `product`, `type`, `lookup_key` → `lookup_keys[]`, `recurring_interval` → `recurring[interval]` |
| `coupons()` · `promotion_codes()` · `tax_rates()` | `/v1/coupons` · `/v1/promotion_codes` · `/v1/tax_rates` | `created`; `active`, `code`, `coupon`, `customer`; `active`, `inclusive` |
| `accounts()` · `application_fees()` · `transfers()` | Connect: `/v1/accounts` · `/v1/application_fees` · `/v1/transfers` | `created`; `charge`; `destination`, `transfer_group` |
| `events()` | `/v1/events` | `created`; `type` (`=`, `IN` → `types[]`, `starts_with(type, 'invoice.')` → `type=invoice.*`). Stripe keeps 30 days |
| `webhook_endpoints()` | `/v1/webhook_endpoints` | — (URL **host only**; signing secrets and URL paths never leave the worker) |
| `files()` | `/v1/files` | `created`; `purpose` (metadata only, no contents) |

**Stripe Sigma**: running Sigma SQL is not part of the Stripe API, but the results of your
*scheduled* Sigma queries are: `stripe.reporting.sigma_scheduled_query_runs()` lists the runs,
their status and result file ids (`stripe.platform.files()` / `file_links()` hold the files).

### How filters are translated

DuckDB hands the worker the `WHERE` clause; every predicate the SDK receives is also
re-applied exactly to the rows, so translation only ever narrows what Stripe returns.

- **Time ranges** on `created` and the other timestamp columns listed above become
  `created[gte]` / `created[lte]` in whole Unix seconds, exactly equivalent to the SQL bound.
- **Equality / IN** on ids, `status` and `type` become list parameters; an `IN` list on a
  scalar parameter is one request per value (array parameters such as `ids[]`,
  `lookup_keys[]`, `types[]` take it in one). A value outside a parameter's enum matches
  nothing and sends nothing.
- **Search.** When a filter can be expressed by [Stripe Search](https://docs.stripe.com/search)
  but not by the list API (charge `status`, `amount`, customer `name` …) the worker sends one
  Search query (`status:"failed" AND amount>=1000 AND created>=…`, values quoted with
  backslash escapes, at most 10 clauses) — unless a list-only filter such as
  `payment_intent` is present, in which case the strongly consistent list API wins. Search
  results are **eventually consistent** (new or changed objects can take up to a minute to
  appear, and Search is not available for merchants in India); `search :=` opts in explicitly.
- **Expansion.** `fee`, `net`, `settlement_currency` and `available_on` on `charges()` and
  `refunds()` come from the expanded balance transaction. Projecting any of them adds
  `expand[]=data.balance_transaction`: the same number of requests, but larger and slower
  responses. `expand :=` adds your own paths (`expand := ['customer', 'invoice.subscription']`)
  with the same cost model; Stripe allows four levels including `data.`.

## The complete API (generated schemas)

`scripts/generate_api.py` reads the vendored, pinned spec
(`spec/stripe-openapi/spec3.json` from [stripe/openapi](https://github.com/stripe/openapi),
MIT; commit, date, API version and checksums in `spec/stripe-openapi/source.json`) and writes
`src/stripe/generated/endpoints.json`, one descriptor per function, which the worker turns into
table functions at start-up. `make generate` regenerates it (and the replay data and the
every-function SQL test); a unit test fails if the committed output is stale.

Stripe's API has 273 GET endpoints. **144 functions** cover them, in one schema per product area
(vgi-lint caps a schema at 50 objects, so a single `api` schema with everything is not an option):

| Schema | Functions | Covers |
|---|---:|---|
| `stripe.payments` | 30 | charges (+ refunds, dispute), PaymentIntents (+ amount line items), refunds, disputes, SetupIntents and attempts, payment methods, configurations and domains, Apple Pay domains, mandates, sources (+ transactions), tokens, confirmation tokens, 3DS authentications, Checkout Sessions and Payment Links (+ line items), Radar (early fraud warnings, value lists and items), reviews, forwarding requests, payment records and attempt records |
| `stripe.billing` | 45 | customers and their balance / cash-balance transactions, cash balance, discount, bank accounts, cards, sources, payment methods, subscriptions and tax ids; invoices (+ lines), invoice items and payments, rendering templates; credit notes (+ lines, preview, preview lines); quotes (+ line items, computed upfront line items); subscriptions, items, schedules; products (+ features), prices, plans, coupons, promotion codes, shipping rates, trial offers; meters (+ event summaries), alerts, credit grants, credit balance summary and transactions, feedback options; entitlement features and active entitlements; portal configurations; test clocks |
| `stripe.balance` | 7 | balance, balance settings, balance transactions, payouts, top-ups, exchange rates, country specs |
| `stripe.connect` | 9 | your account, connected accounts (+ capabilities, external accounts, persons), transfers (+ reversals), application fees (+ refunds) |
| `stripe.platform` | 7 | events, webhook endpoints, files, file links, app installs, app secrets (names/metadata only) and secret lookup |
| `stripe.tax` | 11 | Stripe Tax calculations and transactions (+ line items), registrations, settings, tax association lookup, tax locations; tax codes, tax ids, tax rates |
| `stripe.issuing` | 9 | cards, cardholders, authorizations, transactions, disputes, tokens, settlements, personalization designs, physical bundles |
| `stripe.treasury` | 11 | financial accounts (+ features), inbound/outbound transfers, outbound payments, credit/debit reversals, received credits/debits, transactions, transaction entries |
| `stripe.terminal` · `identity` · `financial_connections` · `climate` · `reporting` | 3 · 2 · 4 · 3 · 3 | readers, locations, configurations · verification sessions/reports · accounts (+ owners), transactions, sessions · orders, products, suppliers · report runs, report types, Sigma scheduled query runs |
| `stripe.api` | 1 | `get(path, params := MAP)` — any documented GET as one JSON row |

Every GET is accounted for in [`src/stripe/generated/EXCLUDED.md`](src/stripe/generated/EXCLUDED.md):
generated, folded into a generated function (a retrieve-by-id becomes `WHERE id = …` pushdown,
`…/search` becomes `search :=`) or excluded with the reason. Excluded: deprecated aliases
(`/v1/balance/history`, `/v1/linked_accounts/*`, `/v1/link_account_sessions/*`,
`/v1/accounts/{a}/people`, `/v1/accounts/{a}/bank_accounts/{id}`), the binary quote PDF, two
retrieves keyed by two ids with no list (use `api.get`), and two nested retrieves by two ids
(filter the nested list by `id`). Non-GET operations, including `test_helpers/*`
simulations, are writes and are never generated; the one `test_helpers` read (test clocks) is
`stripe.billing.test_clocks()`. **Stripe's v2 API** (`/v2/…`) is not in `spec3.json` (it has
its own spec, authentication and pagination) and is not covered; `api.get` accepts `/v1/`
paths only.

**Columns** follow the response schema: Stripe's own field names; expandable references as
the id (`VARCHAR`); Unix times as `TIMESTAMPTZ`; enums as `VARCHAR` (values listed in the
column comment); integer amounts beside a `currency` as `BIGINT` minor units plus an exact
`<name>_decimal` `DECIMAL(38,3)`; `metadata` as `MAP(VARCHAR, VARCHAR)`; small flat objects
(≤ 6 scalar fields, e.g. an invoice item's `period`) as `STRUCT`; everything deeper as `JSON`;
`raw` is the whole object. Very wide objects keep their most useful columns so the published
column schema stays under vgi-lint's 4,000-character limit (the rest is in `raw`).

**Pushdown** is generated from each endpoint's documented query parameters, and the SDK
re-applies every filter exactly:

- `=` / `IN` on columns that are list parameters (`customer`, `status`, `type`, `charge`, …);
  array parameters (`ids[]`, `lookup_keys[]`, `types[]`) take an `IN` list in one request;
- `created` and other time columns with a range parameter → `[gte]`/`[lte]` in whole seconds;
- boolean parameters (`active`, `livemode`-style flags);
- `id = …` / `IN` (≤ 25) on a function whose resource has a retrieve endpoint → one
  `GET /v1/<resource>/{id}` per id (a missing id is no row), unless the list takes `ids[]`;
- every other documented scalar query parameter is a named argument (`payout :=`,
  `relationship_owner :=`, `card :=`, …), and `params := MAP {'relationship[owner]': 'true'}`
  passes any documented parameter verbatim (unknown or paging parameters are refused);
- paging (`starting_after`) is externalized in the scan state, so scans resume over HTTP.

**Nested lists** (`/v1/customers/{customer}/tax_ids`, `/v1/transfers/{id}/reversals`, the
Treasury lists that require a `financial_account`, …) take the parent id as a named argument
(`customer_id := 'cus_…'`) or a pushed `customer = / IN` filter, and read only those parents.
Without one they **fan out**: list every parent (one request per 100 parents) and read each
parent's children (one request per parent, more if it has over 100). On an account with 10,000
customers a bare `billing.customer_tax_ids()` is ~10,100 requests at Stripe's rate limit, so name
the parents when you can. Lists whose parent Stripe cannot list (tax calculation line items,
source transactions) require the id.

**Redaction.** Every field the spec documents as a credential is replaced by `[redacted]`
before any column is built, `raw` and `JSON` columns included, and is never a column or a pushed
parameter: `client_secret` (PaymentIntents, SetupIntents, Checkout, Identity, Financial
Connections, customer sessions), `secret` (webhook endpoints, ephemeral keys), the invoice
`confirmation_secret`, Terminal Wi-Fi `password` / `private_key_file*`, bank-account tokens,
Klarna `client_token`, full `account_number`s and Identity `id_number`s; and, on those object
types only, an Apps secret's `payload`, an Issuing card's full `number` / `cvc`, and a file
link's `url` (a public, unauthenticated download link — the file link's id, file and expiry
remain).

**Products not enabled.** Endpoints of products your account has not activated (Issuing,
Treasury, Terminal, Identity, Climate, Connect, …) fail with a clear message such as
`stripe: issuing is not enabled on this Stripe account (GET /v1/issuing/cards failed with HTTP
400: …)`; a restricted key without the permission says `the API key has no read permission for
…`.

## Money and types

- `amount`, `fee`, `net`, `total`, … are `BIGINT` in the currency's **minor unit**, exactly as
  Stripe returns them (cents for USD, yen for JPY, fils for KWD).
- Each has a `<name>_decimal` twin, `DECIMAL(38,3)`, in the **major unit**, using Stripe's
  exponent per currency: zero-decimal currencies (BIF, CLP, DJF, GNF, JPY, KMF, KRW, MGA,
  PYG, RWF, VND, VUV, XAF, XOF, XPF), three-decimal ones (BHD, JOD, KWD, OMR, TND) and two
  decimals for everything else — including ISK, HUF, TWD and UGX, which Stripe represents
  with two decimals. Sub-cent unit prices (`prices.unit_amount_precise`,
  `invoice_line_items.unit_amount_decimal`) are `DECIMAL(38,12)`.
- Fees and net are in the *settlement* currency (`settlement_currency`), which can differ
  from the charge currency.
- Timestamps are `TIMESTAMPTZ`; `metadata` is `MAP(VARCHAR, VARCHAR)`; expandable
  references are always ids; `raw` is the whole object as `JSON` with `client_secret` /
  `secret` values replaced by `"[redacted]"`.

## Authentication

```sql
CREATE SECRET stripe (
  TYPE stripe,
  API_KEY 'rk_live_…',              -- restricted key with read permissions (recommended)
  STRIPE_ACCOUNT 'acct_…',          -- optional: Connect, sent as Stripe-Account
  API_VERSION '2026-09-30.endive',  -- optional: Stripe-Version pin (this is the default)
  BASE_URL 'https://api.stripe.com' -- optional: proxies and test fixtures
);
```

Use a [restricted key](https://docs.stripe.com/keys#limit-access) with **Read** access to
the resources you query. The worker never writes, but a full secret key (`sk_…`) can, and
Stripe offers no cheap way to inspect a key's scopes, so the worker cannot tell — it only
logs a notice when a secret key is used. Publishable keys (`pk_…`) are rejected. A
restricted key missing a permission surfaces Stripe's `403 permission_error` for that
function. `stripe_account := 'acct_…'` on any function overrides the secret's account for
one query; `accounts()`, `application_fees()` and `transfers()` need the platform's key
without one.

## Paging and rate limits

Lists are read 100 objects per request with `starting_after` cursors (`page` tokens for
Search). The cursor lives in the scan state, so a long scan resumes on any worker process
over HTTP. 429s, 409 lock timeouts, 5xx and network errors are retried with exponential
backoff and jitter (honouring `Retry-After`); `Stripe-Should-Retry: false` stops a retry
and `true` forces one.

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ (for a source checkout).

```bash
git clone --branch v0.1.0 https://github.com/Query-farm/vgi-stripe.git && cd vgi-stripe
bun install --frozen-lockfile
```

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'stripe' (TYPE vgi, LOCATION '/abs/path/to/vgi-stripe/bin/vgi-stripe-worker');
```

**Haybarn 2.0.1+** (`uvx haybarn-cli`; Haybarn 2.0.0 serves an older vgi extension that cannot attach this worker):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'stripe' (TYPE vgi, LOCATION '/abs/path/to/vgi-stripe/bin/vgi-stripe-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. Tagged releases ship
signed standalone executables (no Bun needed); point `LOCATION` at the downloaded binary.
The same binary serves HTTP with `--http --port 8000` (see the `Dockerfile`).

## Testing

```bash
make test-unit                 # bun unit tests (money, pushdown/search translation, retries, planning, generated layer)
make test-sql                  # test/sql/*.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a real Stripe account. `test/mock_api/server.py` is a
strict, stdlib-only replay server over a generated account
(`test/fixtures/build_fixture.py` → `stripe-account.json`) plus generated data for every other
GET endpoint (`test/fixtures/build_api_fixture.py` → `stripe-api-account.json`, derived from
Stripe's own example objects in `fixtures3.json`, with sentinel values in every credential
field). At start-up it checks every fixture object's fields against the vendored full OpenAPI
spec. `test/sql/api_every_function.test` (generated) calls all 144 generated functions, and
`test/sql/api.test` asserts their pushdown, fan-out, redaction and error behaviour; the key
`rk_test_basic` answers like an account without Issuing/Treasury/Terminal/Identity/Climate.
It enforces the bearer key, the
`Stripe-Version` format and `Stripe-Account`; accepts exactly each endpoint's spec
parameters (unknown or unimplemented ones are a 400); really filters on every list
parameter and time range; evaluates a subset of the Search query language; pages three
objects at a time so every scan crosses page boundaries; expands `expand[]` paths; and
answers a 429, a 500 (both `Stripe-Should-Retry: true`) and a 503 (`false`) once each.
The SQL tests read its `/__requests` log to check exactly what was sent.

The metadata check runs with `execute: false` in CI: every function needs a `stripe`
secret for a live account.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD).

Copyright 2026 Query Farm LLC - https://query.farm
