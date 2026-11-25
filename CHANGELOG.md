# Changelog

## 0.3.0 (2026-11-25)

- VGI protocol 3.4: bump @query-farm/vgi to 0.52.3 and @query-farm/vgi-rpc to 0.30.3. **Requires the
  3.4 vgi extension**: DuckDB 2.0 (`INSTALL vgi FROM query_farm`) or Haybarn 2.0.1+; Haybarn 2.0.0
  still serves the 3.3 extension, which cannot attach this worker.
- The Docker image supports Orchard hosted mode (`VGI_ORCHARD_HOSTED=1`): HTTP only, Orchard Pass
  authentication, large values through the Orchard blob vendor; the HEALTHCHECK uses `HEAD /health`.
- CI and `make` run the SQL tests on haybarn-unittest 2.0.1rc3.

## 0.2.1 (2026-11-16)

- Bump @query-farm/vgi to 0.50.1.
- CI tooling (haybarn-unittest, lint helpers) runs on Python 3.14.

## 0.2.0 (unreleased)

Complete read-only coverage of the Stripe API.

- 144 table functions generated from Stripe's OpenAPI spec (vendored and pinned:
  stripe/openapi a045100, API 2026-09-30.endive), one per GET endpoint, in 13 product
  schemas: payments, billing, balance, connect, platform, tax, issuing, treasury, terminal,
  identity, financial_connections, climate, reporting. Nested lists fan out over their parent.
  `src/stripe/generated/EXCLUDED.md` accounts for all 273 GET endpoints.
- `stripe.api.get(path, params := MAP)`: any documented GET as one JSON row.
- Pushdown generated from documented parameters; `WHERE id = / IN` becomes per-id retrieves;
  other parameters are named arguments; `params := MAP` passes any documented parameter.
- Redaction now covers every credential field the spec documents, in every column.
- Products not enabled on an account, and keys without a permission, give clear errors.
- `stripe.main` is unchanged.

## 0.1.0

First release: Stripe as SQL, read-only.

- 31 table functions over the Stripe REST API: balance, balance transactions, payouts,
  charges, PaymentIntents, refunds, disputes, Radar early fraud warnings, Checkout
  Sessions, customers, payment methods, invoices and line items, invoice items,
  subscriptions and items, subscription schedules, credit notes, billing meters and
  meter event summaries, products, prices, coupons, promotion codes, tax rates, Connect
  accounts, application fees and transfers, events, webhook endpoints and files.
- `stripe` secret: API key (restricted key recommended), Connect account, API version pin, base URL.
- Pushdown into list parameters and time ranges; Stripe Search for filters the list API lacks;
  projection-driven balance-transaction expansion; raw `expand :=` and `search :=`.
- Money as minor-unit `BIGINT` plus exact major-unit `DECIMAL(38,3)` per Stripe's currency exponents.
- Strict offline replay server checked against Stripe's OpenAPI spec.

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Stripe API 2026-09-30.endive · Haybarn 2.0.1rc3 · vgi-lint-check 2.x (unpinned)
