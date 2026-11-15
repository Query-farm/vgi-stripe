# Changelog

## 0.1.0 (unreleased)

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

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Stripe API 2026-09-30.endive · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
