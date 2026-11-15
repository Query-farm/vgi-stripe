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

## Functions

All are table functions in `stripe.main`. Every function also takes
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

**Stripe Sigma** is not exposed by the Stripe API, so it is not available here; this
worker reads the same objects through the REST API instead.

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

**Haybarn 2.0** (`uvx haybarn-cli`):

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
make test-unit                 # bun unit tests (money, pushdown/search translation, retries, planning)
make test-sql                  # test/sql/*.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a real Stripe account. `test/mock_api/server.py` is a
strict, stdlib-only replay server over a generated account
(`test/fixtures/build_fixture.py` → `stripe-account.json`). At start-up it checks every
fixture object's fields against Stripe's OpenAPI spec
([stripe/openapi](https://github.com/stripe/openapi), MIT; trimmed to
`stripe-openapi-subset.json` by `build_spec_subset.py`). It enforces the bearer key, the
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
