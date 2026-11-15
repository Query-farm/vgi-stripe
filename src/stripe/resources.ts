/**
 * The Stripe table functions: one spec per API list endpoint.
 *
 * Column names follow Stripe's own field names (snake_case already), flattened where
 * a nested field is commonly filtered or grouped on (`card_brand`, `card_last4`,
 * `outcome_type`). Expandable references are always exposed as ids. Money columns
 * come in pairs: `<name>` BIGINT in the minor unit and `<name>_decimal` in the major
 * unit (see money.ts). Field locations moved across API versions (e.g. an invoice's
 * subscription now lives under `parent.subscription_details`); extractors read the
 * current location first and fall back to the older one.
 */

import { timestampMicros, utf8, type VgiFunction } from "@query-farm/vgi";
import { prefixValue } from "./pushdown.ts";
import { asStr, at, C, type Col, defineStripeTable, expanding, idOf, type Row } from "./table.ts";

const Q = "stripe.main";

const created = (what: string) => C.time("created", `When the ${what} was created.`);
const CREATED = { created: "created" } as const;
const str = (param: string) => ({ param, kind: "string" as const });
const flag = (param: string) => ({ param, kind: "bool" as const });
const choice = (param: string, choices: readonly string[]) => ({ param, kind: "string" as const, choices });

/** Columns filled from an expanded balance transaction (charges, refunds). */
function balanceTransactionColumns(): Col[] {
  return expanding("balance_transaction", [
    ...C.money(
      "fee",
      "Stripe fees for this movement (from the expanded balance transaction), in the settlement currency.",
      "balance_transaction.fee",
      "balance_transaction.currency",
    ),
    ...C.money(
      "net",
      "Net amount credited or debited to your balance (from the expanded balance transaction), in the settlement currency.",
      "balance_transaction.net",
      "balance_transaction.currency",
    ),
    C.str(
      "settlement_currency",
      "Currency of fee and net (the balance transaction's currency).",
      "balance_transaction.currency",
    ),
    C.time(
      "available_on",
      "When the funds become available in your balance (balance transaction).",
      "balance_transaction.available_on",
    ),
  ]);
}

const EXPAND_COST =
  "Projecting fee, net, settlement_currency or available_on adds expand[]=data.balance_transaction to each page " +
  "request: the same number of requests, larger and slower responses.";

const card = (prefix: string): Col[] => [
  C.str("card_brand", "Card brand: visa, mastercard, amex, discover, jcb, diners, unionpay …", `${prefix}.brand`),
  C.str("card_last4", "Last four digits of the card (Stripe never returns full card numbers).", `${prefix}.last4`),
  C.int("card_exp_month", "Card expiry month (1-12).", `${prefix}.exp_month`),
  C.int("card_exp_year", "Card expiry year (four digits).", `${prefix}.exp_year`),
  C.str("card_funding", "Card funding: credit, debit, prepaid or unknown.", `${prefix}.funding`),
  C.str("card_country", "Two-letter ISO country of the card issuer.", `${prefix}.country`),
];

// ---------------------------------------------------------------------- balance

interface BalanceAmount {
  amount?: number;
  currency?: string;
  source_types?: Record<string, number>;
}

/** Flatten GET /v1/balance into one row per (bucket, currency). */
export function balanceRows(body: unknown): Row[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const buckets: [string, unknown][] = [
    ["available", b.available],
    ["pending", b.pending],
    ["connect_reserved", b.connect_reserved],
    ["instant_available", b.instant_available],
    ["issuing_available", at(b, "issuing.available")],
    ["refund_and_dispute_prefunding_available", at(b, "refund_and_dispute_prefunding.available")],
    ["refund_and_dispute_prefunding_pending", at(b, "refund_and_dispute_prefunding.pending")],
  ];
  const rows: Row[] = [];
  for (const [bucket, list] of buckets) {
    if (!Array.isArray(list)) continue;
    for (const a of list as BalanceAmount[]) rows.push({ ...a, bucket, livemode: b.livemode });
  }
  return rows;
}

export const balance = defineStripeTable({
  name: "balance",
  description: "The account's current Stripe balance, one row per balance bucket and currency",
  title: "Balance",
  category: "balance",
  keywords: "stripe, balance, available, pending, funds, connect reserved, instant payouts",
  docLlm:
    "The current Stripe balance (GET /v1/balance), flattened to one row per bucket and currency: bucket " +
    "(available, pending, connect_reserved, instant_available, issuing_available, refund_and_dispute_prefunding_*), " +
    "currency, amount (minor units) / amount_decimal (major units) and the per-source split (card, bank_account, " +
    "fpx). Use it for 'how much money is available to pay out right now'. One API call; nothing to push down.",
  docMd: "## balance()\n\nThe account balance by bucket and currency.",
  pushdown: "nothing (one call returns the whole balance; filters run locally).",
  path: "/v1/balance",
  single: true,
  rows: balanceRows,
  columns: [
    {
      ...C.str(
        "bucket",
        "available, pending, connect_reserved, instant_available, issuing_available or refund_and_dispute_prefunding_available/pending.",
      ),
      nullable: false,
    },
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    ...C.money("amount", "Balance in this bucket and currency."),
    C.int("source_card", "Portion of the amount from card payments (minor units).", "source_types.card"),
    C.int("source_bank_account", "Portion of the amount from bank debits (minor units).", "source_types.bank_account"),
    C.int("source_fpx", "Portion of the amount from FPX payments (minor units).", "source_types.fpx"),
    C.livemode(),
  ],
  examples: [
    {
      sql: `SELECT currency, amount_decimal FROM ${Q}.balance() WHERE bucket = 'available' ORDER BY currency`,
      description: "Funds available to pay out, per currency",
    },
  ],
});

export const balanceTransactions = defineStripeTable<{ payout: string | null }>({
  name: "balance_transactions",
  description: "Balance transactions: every movement of funds with its amount, Stripe fee and net",
  title: "Balance Transactions",
  category: "balance",
  keywords:
    "stripe, balance transactions, fees, net, ledger, reconciliation, payout reconciliation, reporting category",
  docLlm:
    "Every balance transaction (GET /v1/balance_transactions): one row per movement of funds — charges, refunds, " +
    "adjustments, payouts, transfers, application fees, Stripe fees — with amount, fee, net (each also as an exact " +
    "*_decimal major-unit `DECIMAL`), currency, type, reporting_category, status, source id, created and available_on. " +
    "The authoritative ledger for fee and net-revenue analysis. `payout := 'po_…'` lists only the transactions " +
    "settled in that automatic payout (payout reconciliation). available_on is filtered locally (Stripe has no " +
    "list parameter for it).",
  docMd: "## balance_transactions(payout := NULL)\n\nThe balance ledger: amount, fee and net per movement of funds.",
  pushdown:
    "`created` ranges → `created[gte|lte]`; `type`, `source`, `currency` (=, IN as one request per value) → list " +
    "parameters; `payout :=` → `payout`. `available_on` is filtered locally.",
  path: "/v1/balance_transactions",
  args: { payout: utf8() },
  argDefaults: { payout: null },
  argDocs: { payout: "Only transactions paid out in this automatic payout (po_…)." },
  baseQuery: ({ args }) => ({ payout: args.payout ?? undefined }),
  params: { type: str("type"), source: str("source"), currency: str("currency") },
  ranges: CREATED,
  columns: [
    C.id("Balance transaction id (txn_…)."),
    C.str(
      "type",
      "Transaction type: charge, refund, payout, transfer, application_fee, stripe_fee, adjustment, payment …",
    ),
    C.str(
      "reporting_category",
      "Stripe's reporting category (charge, refund, fee, payout, transfer …), for summaries.",
    ),
    C.str("status", "available or pending."),
    ...C.money("amount", "Gross amount of the transaction."),
    ...C.money("fee", "Fees paid for this transaction."),
    ...C.money("net", "Net impact on the balance (amount - fee)."),
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    C.num("exchange_rate", "Exchange rate used when the transaction converted currencies."),
    C.str("description", "Description of the transaction."),
    C.ref("source", "Id of the object that caused it (ch_…, re_…, po_…, tr_…)."),
    C.str(
      "balance_type",
      "Which balance it affects: payments, issuing, refund_and_dispute_prefunding or risk_reserved.",
    ),
    C.json("fee_details", "Fee breakdown: list of {amount, currency, type, description, application}."),
    created("balance transaction"),
    C.time("available_on", "When the funds become available."),
  ],
  examples: [
    {
      sql: `SELECT type, currency, sum(fee_decimal) AS fees, sum(net_decimal) AS net FROM ${Q}.balance_transactions() WHERE created >= TIMESTAMPTZ '2026-11-01' GROUP BY ALL ORDER BY type, currency`,
      description: "Fees and net by transaction type since 1 November (the date range is pushed down)",
    },
  ],
});

// --------------------------------------------------------------------- payments

export const charges = defineStripeTable({
  name: "charges",
  description: "Charges: card and other payments with amounts, outcome, card brand/last4 and refunds",
  title: "Charges",
  category: "payments",
  keywords: "stripe, charges, payments, card payments, gross volume, failed payments, refunds, outcome, radar",
  docLlm:
    "Every charge (GET /v1/charges, or /v1/charges/search): status (succeeded, pending, failed), amount, " +
    "amount_captured, amount_refunded (each with *_decimal major units), currency, customer, payment_intent, " +
    "captured / paid / refunded / disputed flags, failure_code and message, Radar outcome (type, risk level and " +
    "score), card brand / last4 / expiry / funding / country, billing details, receipt, created and metadata. " +
    "fee, net, settlement_currency and available_on come from the expanded balance transaction and are fetched " +
    "only when projected. Filters on status, amount, currency, refunded, disputed, card_last4 or " +
    "billing_postal_code use the eventually consistent Search API (seconds-to-minutes lag); `search :=` adds a " +
    'raw query such as \'metadata["order_id"]:"6735"\'.',
  docMd: "## charges(search := NULL, expand := NULL)\n\nCharges with their outcome, card details and refund state.",
  pushdown:
    "`created` ranges, `customer`, `payment_intent`, `transfer_group` → list parameters. `status`, `amount` " +
    "(=, <, >, …), `currency`, `refunded`, `disputed`, `card_last4`, `billing_postal_code` → Stripe Search " +
    `(with created/customer) when no list-only filter is present. ${EXPAND_COST}`,
  path: "/v1/charges",
  params: { customer: str("customer"), payment_intent: str("payment_intent"), transfer_group: str("transfer_group") },
  ranges: CREATED,
  search: {
    path: "/v1/charges/search",
    fields: {
      amount: { field: "amount", kind: "number" },
      created: { field: "created", kind: "time" },
      currency: { field: "currency", kind: "string" },
      customer: { field: "customer", kind: "string" },
      disputed: { field: "disputed", kind: "bool" },
      refunded: { field: "refunded", kind: "bool" },
      status: { field: "status", kind: "string" },
      card_last4: { field: "payment_method_details.card.last4", kind: "string" },
      billing_postal_code: { field: "billing_details.address.postal_code", kind: "string" },
    },
  },
  columns: [
    C.id("Charge id (ch_…/py_…)."),
    C.str("status", "succeeded, pending or failed."),
    ...C.money("amount", "Charge amount."),
    ...C.money("amount_captured", "Captured."),
    ...C.money("amount_refunded", "Refunded."),
    C.str("currency", "ISO currency, lowercase."),
    C.ref("customer", "Customer id."),
    C.ref("payment_intent", "PaymentIntent id."),
    C.str("payment_method", "PaymentMethod id."),
    C.str("payment_method_type", "card, sepa_debit, link …", "payment_method_details.type"),
    C.str("description", "Description."),
    C.bool("captured", "Captured?"),
    C.bool("paid", "Succeeded or authorized?"),
    C.bool("refunded", "Fully refunded?"),
    C.bool("disputed", "Disputed?"),
    C.str("failure_code", "Decline code (card_declined …)."),
    C.str("failure_message", "Failure reason."),
    C.str("outcome_type", "authorized, manual_review, issuer_declined, blocked, invalid.", "outcome.type"),
    C.str("outcome_risk_level", "Radar risk: normal, elevated, highest.", "outcome.risk_level"),
    C.int("outcome_risk_score", "Radar risk score 0-100.", "outcome.risk_score"),
    C.str("outcome_seller_message", "Outcome explanation.", "outcome.seller_message"),
    C.str("card_brand", "Card brand (visa, amex …).", "payment_method_details.card.brand"),
    C.str("card_last4", "Card last four digits.", "payment_method_details.card.last4"),
    C.int("card_exp_month", "Card expiry month.", "payment_method_details.card.exp_month"),
    C.int("card_exp_year", "Card expiry year.", "payment_method_details.card.exp_year"),
    C.str("card_funding", "credit, debit, prepaid.", "payment_method_details.card.funding"),
    C.str("card_country", "Card issuer country.", "payment_method_details.card.country"),
    C.str("billing_email", "Billing email.", "billing_details.email"),
    C.str("billing_country", "Billing country.", "billing_details.address.country"),
    C.str("billing_postal_code", "Billing postal code.", "billing_details.address.postal_code"),
    C.str("receipt_url", "Hosted receipt."),
    C.str("transfer_group", "Connect transfer group."),
    C.ref("balance_transaction", "Balance transaction id."),
    ...expanding("balance_transaction", [
      ...C.money("fee", "Stripe fee (settlement currency).", "balance_transaction.fee", "balance_transaction.currency"),
      ...C.money(
        "net",
        "Net to balance (settlement currency).",
        "balance_transaction.net",
        "balance_transaction.currency",
      ),
      C.str("settlement_currency", "Currency of fee and net.", "balance_transaction.currency"),
      C.time("available_on", "When funds become available.", "balance_transaction.available_on"),
    ]),
    created("charge"),
    C.livemode(),
    C.meta("Your metadata."),
  ],
  examples: [
    {
      sql: `SELECT currency, count(*) AS charges, sum(amount_decimal) AS gross FROM ${Q}.charges() WHERE status = 'succeeded' GROUP BY currency ORDER BY currency`,
      description: "Gross volume per currency (status uses Stripe Search)",
    },
    {
      sql: `SELECT id, amount_decimal, fee_decimal, net_decimal FROM ${Q}.charges() WHERE created >= TIMESTAMPTZ '2026-11-01' ORDER BY id`,
      description: "Charges with Stripe fee and net (projecting fee expands the balance transaction)",
    },
  ],
});

export const paymentIntents = defineStripeTable({
  name: "payment_intents",
  description: "PaymentIntents: the lifecycle of each payment attempt, with status, amounts and last error",
  title: "Payment Intents",
  category: "payments",
  keywords: "stripe, payment intents, payments, checkout, conversion, requires payment method, abandoned, sca",
  docLlm:
    "Every PaymentIntent (GET /v1/payment_intents or /search): status (requires_payment_method, " +
    "requires_confirmation, requires_action, processing, requires_capture, canceled, succeeded), amount / " +
    "amount_received / amount_capturable (with *_decimal), currency, customer, latest_charge, payment_method, " +
    "capture and confirmation method, cancellation, last_payment_error code/message/decline code, allowed " +
    "payment_method_types, created and metadata. Use it for conversion and failure analysis. The client_secret is " +
    "never returned. Filters on status, amount or currency use the Search API.",
  docMd: "## payment_intents(search := NULL, expand := NULL)\n\nPaymentIntents and where each payment got to.",
  pushdown:
    "`created` ranges and `customer` → list parameters; `status`, `amount`, `currency` → Stripe Search (with created/customer).",
  path: "/v1/payment_intents",
  params: { customer: str("customer") },
  ranges: CREATED,
  search: {
    path: "/v1/payment_intents/search",
    fields: {
      amount: { field: "amount", kind: "number" },
      created: { field: "created", kind: "time" },
      currency: { field: "currency", kind: "string" },
      customer: { field: "customer", kind: "string" },
      status: { field: "status", kind: "string" },
    },
  },
  columns: [
    C.id("PaymentIntent id (pi_…)."),
    C.str(
      "status",
      "requires_payment_method, requires_confirmation, requires_action, processing, requires_capture, canceled or succeeded.",
    ),
    ...C.money("amount", "Amount intended to be collected."),
    ...C.money("amount_received", "Amount received."),
    ...C.money("amount_capturable", "Amount that can still be captured."),
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    C.ref("customer", "Customer id (cus_…), if any."),
    C.ref("latest_charge", "Latest charge id (ch_…)."),
    C.ref("payment_method", "PaymentMethod id (pm_…)."),
    C.strList("payment_method_types", "Payment method types this PaymentIntent may use."),
    C.str("capture_method", "automatic, automatic_async or manual."),
    C.str("confirmation_method", "automatic or manual."),
    C.str("setup_future_usage", "on_session or off_session when the method is saved for reuse."),
    C.str("cancellation_reason", "Why it was canceled (abandoned, duplicate, requested_by_customer, …)."),
    C.time("canceled_at", "When it was canceled."),
    C.str("last_payment_error_code", "Error code of the last failed attempt.", "last_payment_error.code"),
    C.str(
      "last_payment_error_decline_code",
      "Issuer decline code of the last failed attempt.",
      "last_payment_error.decline_code",
    ),
    C.str("last_payment_error_message", "Message of the last failed attempt.", "last_payment_error.message"),
    C.str("description", "Description."),
    C.str("receipt_email", "Where the receipt is sent."),
    C.str("statement_descriptor", "Statement descriptor."),
    C.int("application_fee_amount", "Connect application fee (minor units)."),
    C.str("transfer_group", "Connect transfer group."),
    created("PaymentIntent"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT status, count(*) AS intents FROM ${Q}.payment_intents() WHERE created >= TIMESTAMPTZ '2026-11-01' GROUP BY status ORDER BY intents DESC`,
      description: "PaymentIntent funnel since 1 November",
    },
  ],
});

export const refunds = defineStripeTable({
  name: "refunds",
  description: "Refunds of charges and PaymentIntents, with status and reason",
  title: "Refunds",
  category: "payments",
  keywords: "stripe, refunds, returns, reversals, refund reason, chargebacks",
  docLlm:
    "Every refund (GET /v1/refunds): amount (+ amount_decimal), currency, status (pending, requires_action, " +
    "succeeded, failed, canceled), reason (duplicate, fraudulent, requested_by_customer, " +
    "expired_uncaptured_charge), charge, payment_intent, failure_reason, created and metadata. fee / net / " +
    "settlement_currency / available_on come from the expanded balance transaction when projected.",
  docMd: "## refunds(expand := NULL)\n\nRefunds and why they happened.",
  pushdown: `\`created\` ranges, \`charge\`, \`payment_intent\` → list parameters. ${EXPAND_COST}`,
  path: "/v1/refunds",
  params: { charge: str("charge"), payment_intent: str("payment_intent") },
  ranges: CREATED,
  columns: [
    C.id("Refund id (re_…)."),
    C.str("status", "pending, requires_action, succeeded, failed or canceled."),
    ...C.money("amount", "Amount refunded."),
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    C.str("reason", "duplicate, fraudulent, requested_by_customer or expired_uncaptured_charge."),
    C.ref("charge", "Refunded charge id (ch_…)."),
    C.ref("payment_intent", "Refunded PaymentIntent id (pi_…)."),
    C.str("failure_reason", "Why the refund failed, if it did."),
    C.str("receipt_number", "Refund receipt number."),
    C.str("description", "Description."),
    C.ref("balance_transaction", "Balance transaction id (txn_…)."),
    ...balanceTransactionColumns(),
    created("refund"),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT reason, currency, sum(amount_decimal) AS refunded FROM ${Q}.refunds() WHERE status = 'succeeded' GROUP BY ALL ORDER BY reason, currency`,
      description: "Refunded amount by reason and currency",
    },
  ],
});

export const disputes = defineStripeTable({
  name: "disputes",
  description: "Disputes (chargebacks) with status, reason, amount and evidence deadline",
  title: "Disputes",
  category: "payments",
  keywords: "stripe, disputes, chargebacks, fraud, evidence, inquiry, won, lost",
  docLlm:
    "Every dispute (GET /v1/disputes): status (warning_needs_response, warning_under_review, warning_closed, " +
    "needs_response, under_review, won, lost, prevented), reason (fraudulent, product_not_received, duplicate …), " +
    "amount (+ amount_decimal), currency, charge, payment_intent, evidence_due_by, has_evidence, past_due, " +
    "submission_count, is_charge_refundable, card network reason code, created and metadata.",
  docMd: "## disputes(expand := NULL)\n\nChargebacks and inquiries, with evidence deadlines.",
  pushdown: "`created` ranges, `charge`, `payment_intent` → list parameters.",
  path: "/v1/disputes",
  params: { charge: str("charge"), payment_intent: str("payment_intent") },
  ranges: CREATED,
  columns: [
    C.id("Dispute id (dp_… or du_…)."),
    C.str(
      "status",
      "warning_needs_response, warning_under_review, warning_closed, needs_response, under_review, won, lost or prevented.",
    ),
    C.str(
      "reason",
      "fraudulent, product_not_received, duplicate, subscription_canceled, credit_not_processed, general …",
    ),
    ...C.money("amount", "Disputed amount (usually the full charge)."),
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    C.ref("charge", "Disputed charge id (ch_…)."),
    C.ref("payment_intent", "PaymentIntent id (pi_…)."),
    C.time("evidence_due_by", "Deadline to submit evidence.", "evidence_details.due_by"),
    C.bool("has_evidence", "Whether evidence has been staged.", "evidence_details.has_evidence"),
    C.bool("past_due", "Whether the evidence deadline has passed.", "evidence_details.past_due"),
    C.int("submission_count", "Times evidence has been submitted.", "evidence_details.submission_count"),
    C.bool("is_charge_refundable", "Whether the charge can still be refunded instead."),
    C.str("card_brand", "Card brand of the disputed payment.", "payment_method_details.card.brand"),
    C.str("network_reason_code", "Card network's reason code.", "payment_method_details.card.network_reason_code"),
    created("dispute"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT id, reason, amount_decimal, currency, evidence_due_by FROM ${Q}.disputes() WHERE status IN ('needs_response', 'warning_needs_response') ORDER BY evidence_due_by`,
      description: "Disputes awaiting a response, by deadline",
    },
  ],
});

export const earlyFraudWarnings = defineStripeTable({
  name: "early_fraud_warnings",
  description: "Radar early fraud warnings: issuer fraud reports that often precede a dispute",
  title: "Radar Early Fraud Warnings",
  category: "payments",
  keywords: "stripe, radar, early fraud warning, efw, fraud, tc40, safe, chargeback risk",
  docLlm:
    "Radar early fraud warnings (GET /v1/radar/early_fraud_warnings): issuer reports of fraud on a charge " +
    "(fraud_type such as card_never_received, fraudulent_card_application, made_with_counterfeit_card, " +
    "made_with_lost_card, made_with_stolen_card, unauthorized_use_of_card), the charge and payment_intent, " +
    "whether it is still actionable (refund to avoid a dispute) and created.",
  docMd: "## early_fraud_warnings(expand := NULL)\n\nIssuer fraud reports (TC40/SAFE) from Radar.",
  pushdown: "`created` ranges, `charge`, `payment_intent` → list parameters.",
  path: "/v1/radar/early_fraud_warnings",
  params: { charge: str("charge"), payment_intent: str("payment_intent") },
  ranges: CREATED,
  columns: [
    C.id("Early fraud warning id (issfr_…)."),
    C.str(
      "fraud_type",
      "card_never_received, fraudulent_card_application, made_with_counterfeit_card, made_with_lost_card, made_with_stolen_card, misc or unauthorized_use_of_card.",
    ),
    C.bool("actionable", "Whether refunding the charge can still avert a dispute."),
    C.ref("charge", "Charge id (ch_…)."),
    C.ref("payment_intent", "PaymentIntent id (pi_…)."),
    created("warning"),
    C.livemode(),
  ],
  examples: [
    {
      sql: `SELECT fraud_type, count(*) AS warnings FROM ${Q}.early_fraud_warnings() WHERE actionable GROUP BY fraud_type ORDER BY fraud_type`,
      description: "Actionable early fraud warnings by fraud type",
    },
  ],
});

export const checkoutSessions = defineStripeTable({
  name: "checkout_sessions",
  description: "Checkout Sessions: hosted checkout attempts with status, mode and totals",
  title: "Checkout Sessions",
  category: "payments",
  keywords: "stripe, checkout, checkout sessions, conversion, abandoned carts, payment links, hosted checkout",
  docLlm:
    "Every Checkout Session (GET /v1/checkout/sessions): status (open, complete, expired), mode (payment, " +
    "subscription, setup), payment_status, customer and customer email/name, amount_subtotal / amount_total (+ " +
    "*_decimal), currency, the payment_intent / subscription / invoice / payment_link it produced, " +
    "client_reference_id, expires_at, created and metadata. Use it for checkout conversion and abandonment.",
  docMd: "## checkout_sessions(expand := NULL)\n\nHosted Checkout attempts and what they produced.",
  pushdown:
    "`created` ranges, `customer`, `status`, `payment_intent`, `payment_link`, `subscription`, `customer_email` " +
    "(→ `customer_details[email]`) → list parameters.",
  path: "/v1/checkout/sessions",
  params: {
    customer: str("customer"),
    status: choice("status", ["open", "complete", "expired"]),
    payment_intent: str("payment_intent"),
    payment_link: str("payment_link"),
    subscription: str("subscription"),
    customer_email: str("customer_details[email]"),
  },
  ranges: CREATED,
  columns: [
    C.id("Checkout Session id (cs_…)."),
    C.str("status", "open, complete or expired."),
    C.str("mode", "payment, subscription or setup."),
    C.str("payment_status", "paid, unpaid or no_payment_required."),
    C.ref("customer", "Customer id (cus_…), if any."),
    C.str(
      "customer_email",
      "Customer email collected or prefilled.",
      (r) => at(r, "customer_details.email") ?? r.customer_email,
    ),
    C.str("customer_name", "Customer name collected.", "customer_details.name"),
    ...C.money("amount_subtotal", "Total before discounts and taxes."),
    ...C.money("amount_total", "Total after discounts and taxes."),
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    C.ref("payment_intent", "PaymentIntent id (pi_…) for payment mode."),
    C.ref("subscription", "Subscription id (sub_…) for subscription mode."),
    C.ref("invoice", "Invoice id (in_…), if one was created."),
    C.ref("payment_link", "Payment Link id (plink_…) that created the session."),
    C.str("client_reference_id", "Your reference passed to Checkout."),
    C.str("locale", "Checkout locale."),
    C.time("expires_at", "When the session expires."),
    created("session"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT status, count(*) AS sessions FROM ${Q}.checkout_sessions() WHERE created >= TIMESTAMPTZ '2026-11-01' GROUP BY status ORDER BY status`,
      description: "Checkout conversion: complete vs expired sessions",
    },
  ],
});

// --------------------------------------------------------------------- payouts

export const payouts = defineStripeTable({
  name: "payouts",
  description: "Payouts to your bank account or debit card, with status and arrival date",
  title: "Payouts",
  category: "balance",
  keywords: "stripe, payouts, transfers to bank, settlement, arrival date, instant payouts, failed payouts",
  docLlm:
    "Every payout (GET /v1/payouts): status (paid, pending, in_transit, canceled, failed), amount (+ " +
    "amount_decimal), currency, arrival_date, automatic, method (standard / instant), type (bank_account / card), " +
    "destination, balance_transaction, failure code/message, reconciliation_status, created and metadata. Join " +
    "balance_transactions(payout := id) to see what a payout contained.",
  docMd: "## payouts(expand := NULL)\n\nMoney paid out of Stripe to your bank or card.",
  pushdown: "`created` and `arrival_date` ranges, `status`, `destination` → list parameters.",
  path: "/v1/payouts",
  params: {
    status: choice("status", ["paid", "pending", "in_transit", "canceled", "failed"]),
    destination: str("destination"),
  },
  ranges: { created: "created", arrival_date: "arrival_date" },
  columns: [
    C.id("Payout id (po_…)."),
    C.str("status", "paid, pending, in_transit, canceled or failed."),
    ...C.money("amount", "Amount paid out."),
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    C.time("arrival_date", "Date the payout is expected to arrive."),
    C.bool("automatic", "True for scheduled automatic payouts."),
    C.str("method", "standard or instant."),
    C.str("type", "bank_account or card."),
    C.ref("destination", "Bank account or card id (ba_… / card_…)."),
    C.ref("balance_transaction", "Balance transaction id (txn_…)."),
    C.str("failure_code", "Why it failed (account_closed, insufficient_funds …)."),
    C.str("failure_message", "Failure explanation."),
    C.str("reconciliation_status", "completed, in_progress or not_applicable."),
    C.str("source_type", "Balance it came from: card, bank_account or fpx."),
    C.str("statement_descriptor", "Descriptor on the bank statement."),
    C.str("description", "Description."),
    created("payout"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT id, amount_decimal, currency, arrival_date FROM ${Q}.payouts() WHERE status = 'paid' AND arrival_date >= TIMESTAMPTZ '2026-11-01' ORDER BY arrival_date`,
      description: "Paid payouts arriving since 1 November (both filters push down)",
    },
  ],
});

// -------------------------------------------------------------------- customers

export const customers = defineStripeTable({
  name: "customers",
  description: "Customers with contact details, balance, delinquency and address",
  title: "Customers",
  category: "customers",
  keywords: "stripe, customers, clients, email lookup, delinquent, customer balance, crm",
  docLlm:
    "Every customer (GET /v1/customers or /search): email, name, phone, description, currency, balance (credit " +
    "balance, + balance_decimal), delinquent, default_source, invoice_prefix, tax_exempt, address " +
    "(country/state/city/postal code), preferred_locales, test_clock, created and metadata. `email = '…'` uses the " +
    "list API's exact (case-sensitive) email parameter; name / phone filters and starts_with / contains on email " +
    "or name use Search (substring, eventually consistent).",
  docMd: "## customers(search := NULL, expand := NULL)\n\nCustomers and their contact details.",
  pushdown:
    "`created` ranges, `email` (=, IN), `test_clock` → list parameters; `name`, `phone` (=) and starts_with/contains " +
    "on `name` or `email` (3+ characters, as `~` substring) → Stripe Search.",
  path: "/v1/customers",
  params: { email: str("email"), test_clock: str("test_clock") },
  ranges: CREATED,
  search: {
    path: "/v1/customers/search",
    fields: {
      created: { field: "created", kind: "time" },
      email: { field: "email", kind: "string", substring: true },
      name: { field: "name", kind: "string", substring: true },
      phone: { field: "phone", kind: "string" },
    },
  },
  columns: [
    C.id("Customer id (cus_…)."),
    C.str("email", "Customer email."),
    C.str("name", "Customer or business name."),
    C.str("phone", "Phone number."),
    C.str("description", "Description."),
    C.str("currency", "Default currency for recurring billing."),
    ...C.money("balance", "Customer credit balance applied to future invoices (negative = credit)."),
    C.bool("delinquent", "True if the latest invoice payment failed or is overdue."),
    C.ref("default_source", "Default legacy payment source id."),
    C.str("default_payment_method", "Default PaymentMethod for invoices (pm_…).", (r) =>
      idOf(at(r, "invoice_settings.default_payment_method")),
    ),
    C.str("invoice_prefix", "Prefix for invoice numbers."),
    C.str("tax_exempt", "none, exempt or reverse."),
    C.str("address_country", "Address country (ISO 2).", "address.country"),
    C.str("address_state", "Address state or region.", "address.state"),
    C.str("address_city", "Address city.", "address.city"),
    C.str("address_postal_code", "Address postal code.", "address.postal_code"),
    C.strList("preferred_locales", "Preferred locales for emails and invoices."),
    C.ref("test_clock", "Test clock id, for test-mode simulations."),
    created("customer"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT id, name, created FROM ${Q}.customers() WHERE email = 'ada@example.com'`,
      description: "Look a customer up by exact email (list API email parameter)",
    },
    {
      sql: `SELECT address_country, count(*) AS customers FROM ${Q}.customers() GROUP BY address_country ORDER BY customers DESC`,
      description: "Customers by country",
    },
  ],
});

export const paymentMethods = defineStripeTable<{ customer_id: string | null }>({
  name: "payment_methods",
  description: "Customers' saved payment methods: type, card brand, last4 and expiry (never full numbers)",
  title: "Payment Methods",
  category: "customers",
  keywords: "stripe, payment methods, cards, saved cards, card expiry, wallets, card brand, last4",
  docLlm:
    "PaymentMethods attached to customers (GET /v1/customers/{id}/payment_methods): id, customer, type (card, " +
    "us_bank_account, sepa_debit, link …), card brand / last4 / exp_month / exp_year / funding / country / " +
    "wallet, billing name/email/postal code, allow_redisplay, created and metadata. Only these card fields are " +
    "exposed; Stripe never returns full card numbers. `customer_id := 'cus_…'` or a pushed `customer = / IN` " +
    "reads just those customers; otherwise every customer is listed and read in turn (one call per customer).",
  docMd: "## payment_methods(customer_id := NULL, expand := NULL)\n\nSaved payment methods per customer.",
  pushdown:
    "`customer` (=, IN) or `customer_id :=` → one call per customer; otherwise fans out over all customers. `type` → `type`.",
  path: "/v1/payment_methods",
  args: { customer_id: utf8() },
  argDefaults: { customer_id: null },
  argDocs: { customer_id: "Read only this customer's payment methods (cus_…)." },
  params: { type: str("type") },
  fanout: {
    key: "customer",
    arg: "customer_id",
    parent: () => ({ path: "/v1/customers", query: {} }),
    child: (id) => ({ path: `/v1/customers/${encodeURIComponent(id)}/payment_methods` }),
  },
  columns: [
    C.id("PaymentMethod id (pm_…)."),
    {
      ...C.str(
        "customer",
        "Customer id (cus_…) the method is attached to.",
        (r) => r.__ctx?.customer ?? idOf(r.customer),
      ),
      nullable: false,
    },
    C.str("type", "card, us_bank_account, sepa_debit, link, …"),
    ...card("card"),
    C.str("card_wallet", "Wallet used for the card: apple_pay, google_pay, link …", "card.wallet.type"),
    C.str("card_display_brand", "Brand shown to the customer (e.g. cartes_bancaires).", "card.display_brand"),
    C.str("billing_name", "Billing name.", "billing_details.name"),
    C.str("billing_email", "Billing email.", "billing_details.email"),
    C.str("billing_postal_code", "Billing postal code.", "billing_details.address.postal_code"),
    C.str("allow_redisplay", "always, limited or unspecified."),
    created("payment method"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT customer, card_brand, card_last4, card_exp_month, card_exp_year FROM ${Q}.payment_methods() WHERE type = 'card' AND card_exp_year <= 2026 ORDER BY customer`,
      description: "Saved cards that expire by the end of 2026",
    },
  ],
});

// ----------------------------------------------------------------------- billing

const INVOICE_STATUSES = ["draft", "open", "paid", "uncollectible", "void"] as const;
const COLLECTION = ["charge_automatically", "send_invoice"] as const;

const invoiceSubscription = (r: Row) => idOf(at(r, "parent.subscription_details.subscription")) ?? idOf(r.subscription);

export const invoices = defineStripeTable({
  name: "invoices",
  description: "Invoices with status, totals, amounts due and paid, and lifecycle timestamps",
  title: "Invoices",
  category: "billing",
  keywords: "stripe, invoices, billing, accounts receivable, amount due, overdue, dunning, revenue",
  docLlm:
    "Every invoice (GET /v1/invoices or /search): number, status (draft, open, paid, uncollectible, void), " +
    "collection_method, billing_reason, customer with email/name, subscription, currency, total, subtotal, " +
    "amount_due, amount_paid, amount_remaining (each + *_decimal), attempt_count, due_date, period start/end, " +
    "finalized_at, paid_at, voided_at, hosted_invoice_url, invoice_pdf, created and metadata. Lines are in " +
    "invoice_line_items(). Filters on number, total, currency or receipt_number use Search.",
  docMd: "## invoices(search := NULL, expand := NULL)\n\nInvoices and what is still owed on them.",
  pushdown:
    "`created` and `due_date` ranges, `customer`, `status`, `subscription`, `collection_method` → list parameters; " +
    "`number`, `total`, `currency`, `receipt_number` → Stripe Search.",
  path: "/v1/invoices",
  params: {
    customer: str("customer"),
    status: choice("status", INVOICE_STATUSES),
    subscription: str("subscription"),
    collection_method: choice("collection_method", COLLECTION),
  },
  ranges: { created: "created", due_date: "due_date" },
  search: {
    path: "/v1/invoices/search",
    fields: {
      created: { field: "created", kind: "time" },
      currency: { field: "currency", kind: "string" },
      customer: { field: "customer", kind: "string" },
      number: { field: "number", kind: "string" },
      receipt_number: { field: "receipt_number", kind: "string" },
      status: { field: "status", kind: "string" },
      subscription: { field: "subscription", kind: "string" },
      total: { field: "total", kind: "number" },
    },
  },
  columns: [
    C.id("Invoice id (in_…)."),
    C.str("number", "Invoice number shown to the customer."),
    C.str("status", "draft, open, paid, uncollectible or void."),
    C.str("collection_method", "charge_automatically or send_invoice."),
    C.str("billing_reason", "subscription_cycle, subscription_create, subscription_update, manual, upcoming …"),
    C.ref("customer", "Customer id (cus_…)."),
    C.str("customer_email", "Customer email at finalization."),
    C.str("customer_name", "Customer name at finalization."),
    C.str("subscription", "Subscription id (sub_…) that produced the invoice, if any.", invoiceSubscription),
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    ...C.money("total", "Total after discounts and taxes."),
    ...C.money("subtotal", "Total before discounts and taxes."),
    ...C.money("amount_due", "Final amount due."),
    ...C.money("amount_paid", "Amount paid."),
    ...C.money("amount_remaining", "Amount still due."),
    C.int("attempt_count", "Payment attempts made."),
    C.bool("attempted", "Whether payment was attempted."),
    C.bool("auto_advance", "Whether Stripe automatically advances the invoice."),
    C.time("due_date", "When payment is due (send_invoice)."),
    C.time("period_start", "Start of the usage period."),
    C.time("period_end", "End of the usage period."),
    C.time("finalized_at", "When it was finalized.", "status_transitions.finalized_at"),
    C.time("paid_at", "When it was paid.", "status_transitions.paid_at"),
    C.time("voided_at", "When it was voided.", "status_transitions.voided_at"),
    C.time(
      "marked_uncollectible_at",
      "When it was marked uncollectible.",
      "status_transitions.marked_uncollectible_at",
    ),
    C.time("next_payment_attempt", "Next automatic payment attempt."),
    C.str("hosted_invoice_url", "Hosted invoice page."),
    C.str("invoice_pdf", "Invoice PDF link."),
    C.str("receipt_number", "Receipt number."),
    C.str("description", "Memo."),
    created("invoice"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT number, customer_email, amount_remaining_decimal, currency, due_date FROM ${Q}.invoices() WHERE status = 'open' ORDER BY due_date`,
      description: "Open invoices and what is still due",
    },
  ],
});

export const invoiceLineItems = defineStripeTable<{ invoice_id: string | null }>({
  name: "invoice_line_items",
  description: "Invoice line items: each charge on an invoice with price, product, period and amount",
  title: "Invoice Line Items",
  category: "billing",
  keywords: "stripe, invoice lines, line items, billing detail, proration, usage, revenue by product",
  docLlm:
    "Lines of invoices (GET /v1/invoices/{id}/lines): invoice_id, description, amount (+ amount_decimal), " +
    "currency, quantity, price and product, precise unit_amount_decimal, period start/end, subscription, " +
    "subscription_item, invoice_item, proration, discountable and metadata. `invoice_id := 'in_…'` or a pushed " +
    "`invoice_id = / IN` reads just those invoices; otherwise every invoice is listed and its embedded lines are " +
    "used (an extra call only for invoices with more lines than Stripe embeds).",
  docMd: "## invoice_line_items(invoice_id := NULL, expand := NULL)\n\nWhat each invoice charged for.",
  pushdown:
    "`invoice_id` (=, IN) or `invoice_id :=` → one lines call per invoice; otherwise fans out over all invoices.",
  path: "/v1/invoices",
  args: { invoice_id: utf8() },
  argDefaults: { invoice_id: null },
  argDocs: { invoice_id: "Read only this invoice's lines (in_…)." },
  fanout: {
    key: "invoice_id",
    arg: "invoice_id",
    parent: () => ({ path: "/v1/invoices", query: {} }),
    child: (id) => ({ path: `/v1/invoices/${encodeURIComponent(id)}/lines` }),
    embedded: (inv) =>
      inv.lines && Array.isArray(inv.lines.data) ? { data: inv.lines.data, hasMore: !!inv.lines.has_more } : undefined,
  },
  columns: [
    C.id("Line item id (il_…)."),
    C.ctx("invoice_id", "Invoice id (in_…) the line belongs to.", "invoice_id"),
    C.str("description", "Line description."),
    ...C.money("amount", "Line amount (quantity × unit price, before discounts and taxes)."),
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    C.int("quantity", "Quantity billed."),
    C.str("price", "Price id (price_…).", (r) => idOf(at(r, "pricing.price_details.price")) ?? idOf(r.price)),
    C.str(
      "product",
      "Product id (prod_…).",
      (r) => idOf(at(r, "pricing.price_details.product")) ?? idOf(at(r, "price.product")),
    ),
    C.unitDecimal(
      "unit_amount_decimal",
      "Unit price in the major unit with sub-minor-unit precision (DECIMAL(38,12)).",
      (r) => at(r, "pricing.unit_amount_decimal") ?? r.unit_amount_excluding_tax ?? at(r, "price.unit_amount_decimal"),
    ),
    C.time("period_start", "Start of the billed period.", "period.start"),
    C.time("period_end", "End of the billed period.", "period.end"),
    C.str(
      "subscription",
      "Subscription id (sub_…), if any.",
      (r) => idOf(r.subscription) ?? idOf(at(r, "parent.subscription_item_details.subscription")),
    ),
    C.str(
      "subscription_item",
      "Subscription item id (si_…), if any.",
      (r) => asStr(at(r, "parent.subscription_item_details.subscription_item")) ?? idOf(r.subscription_item),
    ),
    C.str(
      "invoice_item",
      "Invoice item id (ii_…), if the line came from one.",
      (r) => asStr(at(r, "parent.invoice_item_details.invoice_item")) ?? idOf(r.invoice_item),
    ),
    C.bool(
      "proration",
      "Whether the line is a proration.",
      (r) =>
        at(r, "parent.subscription_item_details.proration") ??
        at(r, "parent.invoice_item_details.proration") ??
        r.proration,
    ),
    C.bool("discountable", "Whether discounts apply to the line."),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT product, currency, sum(amount_decimal) AS billed FROM ${Q}.invoice_line_items() GROUP BY ALL ORDER BY product, currency`,
      description: "Billed amount per product across all invoices",
    },
  ],
});

export const invoiceItems = defineStripeTable({
  name: "invoice_items",
  description: "Invoice items: one-off and pending charges added to a customer's next invoice",
  title: "Invoice Items",
  category: "billing",
  keywords: "stripe, invoice items, pending charges, one-off charges, add-ons, prorations",
  docLlm:
    "Invoice items (GET /v1/invoiceitems): customer, invoice (NULL while pending), pending, amount (+ " +
    "amount_decimal), currency, description, quantity, price, subscription, proration, discountable, date, " +
    "period start/end and metadata. `WHERE pending` lists items not yet on an invoice.",
  docMd: "## invoice_items(expand := NULL)\n\nCharges waiting for (or added to) an invoice.",
  pushdown: "`date` ranges → `created[…]`; `customer`, `invoice`, `pending` → list parameters.",
  path: "/v1/invoiceitems",
  params: { customer: str("customer"), invoice: str("invoice"), pending: flag("pending") },
  ranges: { date: "created" },
  columns: [
    C.id("Invoice item id (ii_…)."),
    C.ref("customer", "Customer id (cus_…)."),
    C.ref("invoice", "Invoice id (in_…), NULL while pending."),
    C.bool("pending", "True while the item is not yet on an invoice.", (r) => r.invoice == null),
    ...C.money("amount", "Amount (quantity × unit price)."),
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    C.str("description", "Description."),
    C.int("quantity", "Quantity."),
    C.str("price", "Price id (price_…).", (r) => idOf(at(r, "pricing.price_details.price")) ?? idOf(r.price)),
    C.str(
      "subscription",
      "Subscription id (sub_…), if any.",
      (r) => idOf(at(r, "parent.subscription_details.subscription")) ?? idOf(r.subscription),
    ),
    C.bool("proration", "Whether it is a proration."),
    C.bool("discountable", "Whether discounts apply."),
    C.time("date", "When the invoice item was created."),
    C.time("period_start", "Start of the period.", "period.start"),
    C.time("period_end", "End of the period.", "period.end"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT customer, sum(amount_decimal) AS pending_total, currency FROM ${Q}.invoice_items() WHERE pending GROUP BY ALL ORDER BY customer`,
      description: "Pending (not yet invoiced) items per customer",
    },
  ],
});

const SUB_STATUSES = [
  "active",
  "canceled",
  "ended",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
] as const;

/** Subscription items embedded in a subscription. */
const subItems = (r: Row): Row[] => (Array.isArray(r.items?.data) ? r.items.data : []);

export const subscriptions = defineStripeTable({
  name: "subscriptions",
  description: "Subscriptions (all statuses, canceled included) with periods, trial and cancellation",
  title: "Subscriptions",
  category: "billing",
  keywords: "stripe, subscriptions, recurring revenue, mrr, churn, trials, cancellations, billing",
  docLlm:
    "Every subscription (GET /v1/subscriptions?status=all — canceled ones included, unlike Stripe's default): " +
    "status (active, trialing, past_due, unpaid, canceled, incomplete, incomplete_expired, paused), customer, " +
    "collection_method, currency, current_period_start/end, billing_cycle_anchor, start_date, trial start/end, " +
    "cancel_at_period_end, cancel_at, canceled_at, ended_at, cancellation_reason, latest_invoice, schedule, " +
    "price_ids / item_count, created and metadata. Items are in subscription_items(). `search :=` takes a Search " +
    "query (e.g. metadata).",
  docMd: "## subscriptions(search := NULL, expand := NULL)\n\nSubscriptions across every status.",
  pushdown:
    "`created`, `current_period_start`, `current_period_end` ranges, `customer`, `status` (else status=all), " +
    "`collection_method`, `test_clock` → list parameters.",
  path: "/v1/subscriptions",
  baseQuery: () => ({ status: "all" }),
  params: {
    customer: str("customer"),
    status: choice("status", SUB_STATUSES),
    collection_method: choice("collection_method", COLLECTION),
    test_clock: str("test_clock"),
  },
  ranges: {
    created: "created",
    current_period_start: "current_period_start",
    current_period_end: "current_period_end",
  },
  search: {
    path: "/v1/subscriptions/search",
    fields: { created: { field: "created", kind: "time" }, status: { field: "status", kind: "string" } },
  },
  columns: [
    C.id("Subscription id (sub_…)."),
    C.str("status", "active, trialing, past_due, unpaid, canceled, incomplete, incomplete_expired or paused."),
    C.ref("customer", "Customer id (cus_…)."),
    C.str("collection_method", "charge_automatically or send_invoice."),
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    C.time(
      "current_period_start",
      "Start of the current billing period.",
      (r) => subItems(r)[0]?.current_period_start ?? r.current_period_start,
    ),
    C.time(
      "current_period_end",
      "End of the current billing period.",
      (r) => subItems(r)[0]?.current_period_end ?? r.current_period_end,
    ),
    C.time("billing_cycle_anchor", "Reference point for billing periods."),
    C.time("start_date", "When the subscription started."),
    C.time("trial_start", "Trial start."),
    C.time("trial_end", "Trial end."),
    C.bool("cancel_at_period_end", "Whether it cancels at the end of the period."),
    C.time("cancel_at", "Scheduled cancellation time."),
    C.time("canceled_at", "When cancellation was requested."),
    C.time("ended_at", "When it ended."),
    C.str(
      "cancellation_reason",
      "cancellation_requested, payment_failed or payment_disputed.",
      "cancellation_details.reason",
    ),
    C.str("cancellation_feedback", "Customer feedback on cancellation.", "cancellation_details.feedback"),
    C.int("days_until_due", "Days until due for send_invoice subscriptions."),
    C.ref("default_payment_method", "Default PaymentMethod id (pm_…)."),
    C.ref("latest_invoice", "Most recent invoice id (in_…)."),
    C.ref("schedule", "Subscription schedule id (sub_sched_…), if any."),
    C.strList("price_ids", "Price ids of the subscription's items.", (r) => subItems(r).map((i) => idOf(i.price))),
    C.int("item_count", "Number of items.", (r) => (r.items?.total_count ?? subItems(r).length) as number),
    C.str("description", "Description."),
    C.ref("test_clock", "Test clock id."),
    created("subscription"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT status, count(*) AS subscriptions FROM ${Q}.subscriptions() GROUP BY status ORDER BY subscriptions DESC`,
      description: "Subscriptions by status (canceled included)",
    },
  ],
});

export const subscriptionItems = defineStripeTable<{ subscription_id: string | null }>({
  name: "subscription_items",
  description: "Subscription items: each price on a subscription with quantity and current period",
  title: "Subscription Items",
  category: "billing",
  keywords: "stripe, subscription items, seats, quantity, mrr by price, recurring prices",
  docLlm:
    "Items of subscriptions (GET /v1/subscription_items?subscription=…): subscription_id, price, product, " +
    "quantity, unit_amount (+ unit_amount_decimal), currency, recurring interval and interval_count, " +
    "current_period_start/end, created and metadata. `subscription_id := 'sub_…'` or a pushed `subscription_id = / " +
    "IN` reads just those; otherwise every subscription (all statuses) is listed and its embedded items used.",
  docMd: "## subscription_items(subscription_id := NULL, expand := NULL)\n\nPrices and quantities per subscription.",
  pushdown:
    "`subscription_id` (=, IN) or `subscription_id :=` → one call each; otherwise fans out over all subscriptions.",
  path: "/v1/subscription_items",
  args: { subscription_id: utf8() },
  argDefaults: { subscription_id: null },
  argDocs: { subscription_id: "Read only this subscription's items (sub_…)." },
  fanout: {
    key: "subscription_id",
    arg: "subscription_id",
    parent: () => ({ path: "/v1/subscriptions", query: { status: "all" } }),
    child: (id) => ({ path: "/v1/subscription_items", query: { subscription: id } }),
    embedded: (s) =>
      s.items && Array.isArray(s.items.data) ? { data: s.items.data, hasMore: !!s.items.has_more } : undefined,
  },
  columns: [
    C.id("Subscription item id (si_…)."),
    C.ctx("subscription_id", "Subscription id (sub_…).", "subscription_id"),
    C.str("price", "Price id (price_…).", (r) => idOf(r.price)),
    C.str("product", "Product id (prod_…).", (r) => idOf(at(r, "price.product"))),
    C.int("quantity", "Quantity (e.g. seats)."),
    ...C.money("unit_amount", "Price per unit.", "price.unit_amount", "price.currency"),
    C.str("currency", "Three-letter ISO currency code, lowercase.", "price.currency"),
    C.str("interval", "Billing interval: day, week, month or year.", "price.recurring.interval"),
    C.int("interval_count", "Intervals between billings.", "price.recurring.interval_count"),
    C.time("current_period_start", "Start of the item's current period."),
    C.time("current_period_end", "End of the item's current period."),
    created("subscription item"),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT product, interval, sum(quantity * unit_amount_decimal) AS recurring, currency FROM ${Q}.subscription_items() GROUP BY ALL ORDER BY product`,
      description: "Recurring amount per product and interval",
    },
  ],
});

export const subscriptionSchedules = defineStripeTable({
  name: "subscription_schedules",
  description: "Subscription schedules: planned phase changes to subscriptions",
  title: "Subscription Schedules",
  category: "billing",
  keywords: "stripe, subscription schedules, phases, planned changes, upgrades, renewals",
  docLlm:
    "Subscription schedules (GET /v1/subscription_schedules): status (not_started, active, completed, released, " +
    "canceled), customer, subscription, end_behavior, current phase start/end, phase_count, canceled_at, " +
    "completed_at, released_at, created, phases (JSON) and metadata.",
  docMd: "## subscription_schedules(expand := NULL)\n\nScheduled subscription changes.",
  pushdown: "`created`, `canceled_at`, `completed_at`, `released_at` ranges and `customer` → list parameters.",
  path: "/v1/subscription_schedules",
  params: { customer: str("customer") },
  ranges: { created: "created", canceled_at: "canceled_at", completed_at: "completed_at", released_at: "released_at" },
  columns: [
    C.id("Schedule id (sub_sched_…)."),
    C.str("status", "not_started, active, completed, released or canceled."),
    C.ref("customer", "Customer id (cus_…)."),
    C.ref("subscription", "Subscription id (sub_…) managed by the schedule."),
    C.str("end_behavior", "release or cancel when the last phase ends."),
    C.time("current_phase_start", "Start of the current phase.", "current_phase.start_date"),
    C.time("current_phase_end", "End of the current phase.", "current_phase.end_date"),
    C.int("phase_count", "Number of phases.", (r) => (Array.isArray(r.phases) ? r.phases.length : null)),
    C.json("phases", "The phases (items, dates, proration behaviour) as JSON."),
    C.time("canceled_at", "When it was canceled."),
    C.time("completed_at", "When it completed."),
    C.time("released_at", "When it was released."),
    C.str("released_subscription", "Subscription id released from the schedule."),
    created("schedule"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT status, count(*) AS schedules FROM ${Q}.subscription_schedules() GROUP BY status ORDER BY status`,
      description: "Schedules by status",
    },
  ],
});

export const creditNotes = defineStripeTable({
  name: "credit_notes",
  description: "Credit notes: adjustments and refunds against finalized invoices",
  title: "Credit Notes",
  category: "billing",
  keywords: "stripe, credit notes, invoice adjustments, credits, refunds, billing corrections",
  docLlm:
    "Credit notes (GET /v1/credit_notes): number, status (issued, void), type (pre_payment, post_payment, mixed), " +
    "reason, customer, invoice, currency, amount, subtotal, total, out_of_band_amount (each + *_decimal), memo, " +
    "effective_at, voided_at, pdf, created and metadata.",
  docMd: "## credit_notes(expand := NULL)\n\nCredits issued against invoices.",
  pushdown: "`created` ranges, `customer`, `invoice` → list parameters.",
  path: "/v1/credit_notes",
  params: { customer: str("customer"), invoice: str("invoice") },
  ranges: CREATED,
  columns: [
    C.id("Credit note id (cn_…)."),
    C.str("number", "Credit note number."),
    C.str("status", "issued or void."),
    C.str("type", "pre_payment, post_payment or mixed."),
    C.str("reason", "duplicate, fraudulent, order_change or product_unsatisfactory."),
    C.ref("customer", "Customer id (cus_…)."),
    C.ref("invoice", "Invoice id (in_…)."),
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    ...C.money("amount", "Credit amount (incl. tax)."),
    ...C.money("subtotal", "Amount before tax and discounts."),
    ...C.money("total", "Total amount credited."),
    ...C.money("out_of_band_amount", "Amount credited outside Stripe."),
    C.str("memo", "Customer-facing memo."),
    C.time("effective_at", "When the credit note took effect."),
    C.time("voided_at", "When it was voided."),
    C.str("pdf", "Credit note PDF link."),
    created("credit note"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT reason, currency, sum(total_decimal) AS credited FROM ${Q}.credit_notes() WHERE status = 'issued' GROUP BY ALL ORDER BY reason`,
      description: "Credited amount by reason",
    },
  ],
});

export const billingMeters = defineStripeTable({
  name: "billing_meters",
  description: "Billing meters: usage events aggregated for usage-based prices",
  title: "Billing Meters",
  category: "billing",
  keywords: "stripe, billing meters, usage based billing, metered, events, aggregation",
  docLlm:
    "Billing meters (GET /v1/billing/meters): display_name, event_name (what you send meter events as), status " +
    "(active, inactive), aggregation formula (sum, count, last), event_time_window, the payload keys for customer " +
    "and value, created and updated. Use with meter_event_summaries() for usage totals.",
  docMd: "## billing_meters(expand := NULL)\n\nMeters for usage-based billing.",
  pushdown: "`status` → `status`.",
  path: "/v1/billing/meters",
  params: { status: choice("status", ["active", "inactive"]) },
  columns: [
    C.id("Meter id (mtr_…)."),
    C.str("display_name", "Meter name."),
    C.str("event_name", "Meter event name your integration sends."),
    C.str("status", "active or inactive."),
    C.str("aggregation_formula", "sum, count or last.", "default_aggregation.formula"),
    C.str("event_time_window", "day or hour pre-aggregation window, if set."),
    C.str("customer_payload_key", "Event payload key holding the customer id.", "customer_mapping.event_payload_key"),
    C.str("value_payload_key", "Event payload key holding the value.", "value_settings.event_payload_key"),
    created("meter"),
    C.time("updated", "When the meter last changed."),
    C.livemode(),
  ],
  examples: [
    {
      sql: `SELECT display_name, event_name, aggregation_formula FROM ${Q}.billing_meters() WHERE status = 'active' ORDER BY display_name`,
      description: "Active billing meters",
    },
  ],
});

/** TIMESTAMPTZ argument (the SDK passes microseconds, as a number or bigint) → whole Unix seconds. */
function argSeconds(v: unknown, name: string): number {
  if (typeof v === "bigint") return Number(v / 1_000_000n);
  if (typeof v === "number") return Math.floor(v / 1_000_000);
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  throw new Error(`meter_event_summaries: ${name} is required`);
}

export const meterEventSummaries = defineStripeTable<{
  meter_id: string;
  customer: string;
  start_time: unknown;
  end_time: unknown;
  value_grouping_window: string | null;
}>({
  name: "meter_event_summaries",
  description: "Aggregated usage for one customer on one billing meter over a time window",
  title: "Meter Event Summaries",
  category: "billing",
  keywords: "stripe, meter event summaries, usage, metered billing, consumption, hourly usage, daily usage",
  docLlm:
    "Usage totals for one billing meter and one customer (GET /v1/billing/meters/{id}/event_summaries): " +
    "meter_event_summaries(meter_id, customer, start_time, end_time, value_grouping_window := 'hour' | 'day'). " +
    "Returns one row per window (or one row for the whole range) with start_time, end_time and aggregated_value. " +
    "Stripe requires start/end on minute boundaries (hour/day boundaries when grouping).",
  docMd:
    "## meter_event_summaries(meter_id, customer, start_time, end_time, value_grouping_window := NULL)\n\nUsage per customer and meter.",
  pushdown: "the arguments become `customer`, `start_time`, `end_time`, `value_grouping_window`.",
  path: ({ args }) => `/v1/billing/meters/${encodeURIComponent(args.meter_id)}/event_summaries`,
  args: {
    meter_id: utf8(),
    customer: utf8(),
    start_time: timestampMicros("UTC"),
    end_time: timestampMicros("UTC"),
    value_grouping_window: utf8(),
  },
  argDefaults: { value_grouping_window: null },
  argDocs: {
    meter_id: "Billing meter id (mtr_…).",
    customer: "Customer id (cus_…) whose usage to sum.",
    start_time: "Start of the window (inclusive), on a minute boundary.",
    end_time: "End of the window (exclusive), on a minute boundary.",
    value_grouping_window: "Split into 'hour' or 'day' buckets; NULL returns one total.",
  },
  argConstraints: { value_grouping_window: { choices: ["hour", "day"] } },
  baseQuery: ({ args }) => ({
    customer: args.customer,
    start_time: argSeconds(args.start_time, "start_time"),
    end_time: argSeconds(args.end_time, "end_time"),
    value_grouping_window: args.value_grouping_window ?? undefined,
  }),
  columns: [
    C.id("Summary id."),
    C.str("meter", "Meter id (mtr_…)."),
    C.time("start_time", "Start of this window (inclusive)."),
    C.time("end_time", "End of this window (exclusive)."),
    C.num("aggregated_value", "Aggregated usage in the window (sum, count or last per the meter)."),
    C.livemode(),
  ],
  examples: [
    {
      sql: `SELECT start_time, aggregated_value FROM ${Q}.meter_event_summaries('mtr_api_calls', 'cus_ada', TIMESTAMPTZ '2026-11-01', TIMESTAMPTZ '2026-11-04', value_grouping_window := 'day') ORDER BY start_time`,
      description: "Daily API-call usage for one customer",
    },
  ],
});

// --------------------------------------------------------------- product catalog

export const products = defineStripeTable({
  name: "products",
  description: "Products in the catalog: name, active state, default price and tax code",
  title: "Products",
  category: "product_catalog",
  keywords: "stripe, products, catalog, plans, sku, offerings",
  docLlm:
    "Products (GET /v1/products or /search): name, active, description, default_price, shippable, unit_label, " +
    "url, tax_code, statement_descriptor, images, created, updated and metadata. Filters on name or description " +
    "(=, starts_with, contains with 3+ characters) use Search.",
  docMd: "## products(search := NULL, expand := NULL)\n\nWhat you sell.",
  pushdown:
    "`created` ranges, `id` (=, IN → `ids[]`), `active`, `shippable`, `url` → list parameters; `name`, " +
    "`description` (=, starts_with, contains) → Stripe Search.",
  path: "/v1/products",
  params: {
    id: { param: "ids", kind: "string", arrayOnly: true },
    active: flag("active"),
    shippable: flag("shippable"),
    url: str("url"),
  },
  ranges: CREATED,
  search: {
    path: "/v1/products/search",
    fields: {
      active: { field: "active", kind: "bool" },
      created: { field: "created", kind: "time" },
      description: { field: "description", kind: "string", substring: true },
      name: { field: "name", kind: "string", substring: true },
      shippable: { field: "shippable", kind: "bool" },
      url: { field: "url", kind: "string" },
    },
  },
  columns: [
    C.id("Product id (prod_…)."),
    C.str("name", "Product name."),
    C.bool("active", "Whether it can be sold."),
    C.str("description", "Description."),
    C.ref("default_price", "Default price id (price_…)."),
    C.bool("shippable", "Whether it is a shipped good."),
    C.str("unit_label", "Unit label shown on receipts and invoices (e.g. seat)."),
    C.str("url", "Product URL."),
    C.ref("tax_code", "Stripe Tax code id (txcd_…)."),
    C.str("statement_descriptor", "Statement descriptor."),
    C.strList("images", "Image URLs."),
    created("product"),
    C.time("updated", "When the product last changed."),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT id, name FROM ${Q}.products() WHERE active ORDER BY name`,
      description: "Active products",
    },
  ],
});

export const prices = defineStripeTable({
  name: "prices",
  description: "Prices: unit amounts, currency, one-time or recurring interval, per product",
  title: "Prices",
  category: "product_catalog",
  keywords: "stripe, prices, pricing, plans, recurring, unit amount, lookup key, tiers",
  docLlm:
    "Prices (GET /v1/prices or /search): product, active, currency, unit_amount (+ unit_amount_decimal) and the " +
    "precise unit_amount_precise (`DECIMAL(38,12)`, for sub-cent prices), type (one_time, recurring), " +
    "billing_scheme, recurring interval / interval_count / usage_type / meter, lookup_key, nickname, " +
    "tax_behavior, tiers_mode, created and metadata.",
  docMd: "## prices(search := NULL, expand := NULL)\n\nHow much each product costs.",
  pushdown:
    "`created` ranges, `active`, `currency`, `product`, `type`, `lookup_key` (→ `lookup_keys[]`), " +
    "`recurring_interval` (→ `recurring[interval]`) → list parameters.",
  path: "/v1/prices",
  params: {
    active: flag("active"),
    currency: str("currency"),
    product: str("product"),
    type: choice("type", ["one_time", "recurring"]),
    lookup_key: { param: "lookup_keys", kind: "string", arrayOnly: true },
    recurring_interval: choice("recurring[interval]", ["day", "week", "month", "year"]),
  },
  ranges: CREATED,
  search: {
    path: "/v1/prices/search",
    fields: {
      active: { field: "active", kind: "bool" },
      currency: { field: "currency", kind: "string" },
      lookup_key: { field: "lookup_key", kind: "string" },
      product: { field: "product", kind: "string" },
      type: { field: "type", kind: "string" },
    },
  },
  columns: [
    C.id("Price id (price_…)."),
    C.ref("product", "Product id (prod_…)."),
    C.bool("active", "Whether new purchases can use it."),
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    ...C.money("unit_amount", "Unit amount (NULL for tiered or custom prices)."),
    C.unitDecimal(
      "unit_amount_precise",
      "Unit amount in the major unit with sub-minor-unit precision.",
      "unit_amount_decimal",
    ),
    C.str("type", "one_time or recurring."),
    C.str("billing_scheme", "per_unit or tiered."),
    C.str("recurring_interval", "day, week, month or year.", "recurring.interval"),
    C.int("recurring_interval_count", "Intervals between billings.", "recurring.interval_count"),
    C.str("recurring_usage_type", "licensed or metered.", "recurring.usage_type"),
    C.str("recurring_meter", "Billing meter id for metered prices.", "recurring.meter"),
    C.str("lookup_key", "Your lookup key for the price."),
    C.str("nickname", "Internal nickname."),
    C.str("tax_behavior", "inclusive, exclusive or unspecified."),
    C.str("tiers_mode", "graduated or volume, for tiered prices."),
    created("price"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT p.id, pr.name, p.unit_amount_decimal, p.currency FROM ${Q}.prices() p JOIN ${Q}.products() pr ON pr.id = p.product WHERE p.recurring_interval = 'month' ORDER BY p.id`,
      description: "Monthly prices with their product names",
    },
  ],
});

export const coupons = defineStripeTable({
  name: "coupons",
  description: "Coupons: percent or amount discounts with duration and redemption counts",
  title: "Coupons",
  category: "product_catalog",
  keywords: "stripe, coupons, discounts, percent off, amount off, redemptions, promotions",
  docLlm:
    "Coupons (GET /v1/coupons): name, percent_off or amount_off (+ amount_off_decimal) with currency, duration " +
    "(once, repeating, forever), duration_in_months, max_redemptions, times_redeemed, redeem_by, valid, created " +
    "and metadata.",
  docMd: "## coupons(expand := NULL)\n\nDiscount definitions.",
  pushdown: "`created` ranges → `created[…]`.",
  path: "/v1/coupons",
  ranges: CREATED,
  columns: [
    C.id("Coupon id (your code or generated)."),
    C.str("name", "Name shown to customers."),
    C.num("percent_off", "Percent discount (0-100), if a percentage coupon."),
    ...C.money("amount_off", "Fixed discount, if an amount coupon."),
    C.str("currency", "Currency of amount_off."),
    C.str("duration", "once, repeating or forever."),
    C.int("duration_in_months", "Months a repeating coupon applies."),
    C.int("max_redemptions", "Maximum redemptions."),
    C.int("times_redeemed", "Redemptions so far."),
    C.time("redeem_by", "Last date it can be redeemed."),
    C.bool("valid", "Whether it can still be applied."),
    created("coupon"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT id, name, percent_off, times_redeemed FROM ${Q}.coupons() WHERE valid ORDER BY times_redeemed DESC`,
      description: "Valid coupons by popularity",
    },
  ],
});

export const promotionCodes = defineStripeTable({
  name: "promotion_codes",
  description: "Promotion codes: customer-facing codes for coupons, with restrictions",
  title: "Promotion Codes",
  category: "product_catalog",
  keywords: "stripe, promotion codes, promo codes, coupons, discounts, redemptions",
  docLlm:
    "Promotion codes (GET /v1/promotion_codes): code, coupon, active, customer restriction, expires_at, " +
    "max_redemptions, times_redeemed, first_time_transaction, minimum_amount (+ minimum_amount_decimal) and " +
    "currency, created and metadata.",
  docMd: "## promotion_codes(expand := NULL)\n\nCodes customers type in at checkout.",
  pushdown: "`created` ranges, `active`, `code`, `coupon`, `customer` → list parameters.",
  path: "/v1/promotion_codes",
  params: { active: flag("active"), code: str("code"), coupon: str("coupon"), customer: str("customer") },
  ranges: CREATED,
  columns: [
    C.id("Promotion code id (promo_…)."),
    C.str("code", "The code customers enter."),
    C.str("coupon", "Coupon id the code applies.", (r) => idOf(at(r, "promotion.coupon")) ?? idOf(r.coupon)),
    C.bool("active", "Whether it can be redeemed."),
    C.ref("customer", "Only this customer may redeem it."),
    C.time("expires_at", "When it expires."),
    C.int("max_redemptions", "Maximum redemptions."),
    C.int("times_redeemed", "Redemptions so far."),
    C.bool("first_time_transaction", "Only for a customer's first purchase.", "restrictions.first_time_transaction"),
    ...C.money(
      "minimum_amount",
      "Minimum order amount.",
      "restrictions.minimum_amount",
      "restrictions.minimum_amount_currency",
    ),
    C.str("minimum_amount_currency", "Currency of minimum_amount.", "restrictions.minimum_amount_currency"),
    created("promotion code"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT code, coupon, times_redeemed FROM ${Q}.promotion_codes() WHERE active ORDER BY code`,
      description: "Active promotion codes and their usage",
    },
  ],
});

export const taxRates = defineStripeTable({
  name: "tax_rates",
  description: "Tax rates: manually configured percentages by jurisdiction",
  title: "Tax Rates",
  category: "product_catalog",
  keywords: "stripe, tax rates, vat, gst, sales tax, jurisdiction, inclusive tax",
  docLlm:
    "Tax rates (GET /v1/tax_rates): display_name, description, percentage, effective_percentage, inclusive, " +
    "active, country, state, jurisdiction, jurisdiction_level, tax_type (vat, gst, sales_tax …), rate_type, " +
    "created and metadata. Stripe Tax calculations are not tax rates and are not listed here.",
  docMd: "## tax_rates(expand := NULL)\n\nManually configured tax rates.",
  pushdown: "`created` ranges, `active`, `inclusive` → list parameters.",
  path: "/v1/tax_rates",
  params: { active: flag("active"), inclusive: flag("inclusive") },
  ranges: CREATED,
  columns: [
    C.id("Tax rate id (txr_…)."),
    C.str("display_name", "Name shown on invoices (e.g. VAT)."),
    C.str("description", "Internal description."),
    C.num("percentage", "Rate in percent."),
    C.num("effective_percentage", "Rate actually applied (0 when not applicable)."),
    C.bool("inclusive", "Whether prices include this tax."),
    C.bool("active", "Whether it can be applied to new objects."),
    C.str("country", "Two-letter country."),
    C.str("state", "State/region code."),
    C.str("jurisdiction", "Jurisdiction label."),
    C.str("jurisdiction_level", "country, state, county, city, district or multiple."),
    C.str("tax_type", "vat, gst, sales_tax, hst, pst, qst, … or NULL."),
    C.str("rate_type", "percentage or flat_amount."),
    created("tax rate"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT display_name, country, percentage FROM ${Q}.tax_rates() WHERE active ORDER BY country`,
      description: "Active tax rates by country",
    },
  ],
});

// ---------------------------------------------------------------------- connect

export const accounts = defineStripeTable({
  name: "accounts",
  description: "Connect connected accounts with onboarding and capability state",
  title: "Connected Accounts",
  category: "connect",
  keywords: "stripe, connect, connected accounts, platforms, marketplaces, onboarding, kyc, requirements",
  docLlm:
    "Connected accounts of a Connect platform (GET /v1/accounts): type (standard, express, custom, none), " +
    "business_type, country, default_currency, email, business name / url / mcc, charges_enabled, " +
    "payouts_enabled, details_submitted, requirements currently due and disabled reason, created and metadata. " +
    "Needs the platform's key and no stripe_account.",
  docMd: "## accounts(expand := NULL)\n\nAccounts connected to your platform.",
  pushdown: "`created` ranges → `created[…]`.",
  path: "/v1/accounts",
  ranges: CREATED,
  columns: [
    C.id("Account id (acct_…)."),
    C.str("type", "standard, express, custom or none."),
    C.str("business_type", "individual, company, non_profit or government_entity."),
    C.str("country", "Account country (ISO 2)."),
    C.str("default_currency", "Default settlement currency."),
    C.str("email", "Account email."),
    C.str("business_name", "Public business name.", "business_profile.name"),
    C.str("business_url", "Business website.", "business_profile.url"),
    C.str("mcc", "Merchant category code.", "business_profile.mcc"),
    C.bool("charges_enabled", "Whether it can create charges."),
    C.bool("payouts_enabled", "Whether Stripe can pay it out."),
    C.bool("details_submitted", "Whether onboarding details were submitted."),
    C.strList("requirements_currently_due", "Requirement fields due now.", "requirements.currently_due"),
    C.str("requirements_disabled_reason", "Why the account is disabled, if it is.", "requirements.disabled_reason"),
    created("account"),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT id, business_name, country FROM ${Q}.accounts() WHERE NOT payouts_enabled ORDER BY id`,
      description: "Connected accounts that cannot be paid out yet",
    },
  ],
});

export const applicationFees = defineStripeTable({
  name: "application_fees",
  description: "Connect application fees collected by the platform on connected-account charges",
  title: "Application Fees",
  category: "connect",
  keywords: "stripe, connect, application fees, platform revenue, take rate, marketplace fees",
  docLlm:
    "Application fees (GET /v1/application_fees): account (connected account), charge, amount and " +
    "amount_refunded (+ *_decimal), currency, refunded, application, originating_transaction, balance_transaction " +
    "and created. The platform's revenue from Connect charges.",
  docMd: "## application_fees(expand := NULL)\n\nPlatform fees from Connect charges.",
  pushdown: "`created` ranges, `charge` → list parameters.",
  path: "/v1/application_fees",
  params: { charge: str("charge") },
  ranges: CREATED,
  columns: [
    C.id("Application fee id (fee_…)."),
    C.ref("account", "Connected account id (acct_…) charged the fee."),
    C.ref("charge", "Charge id the fee was taken from."),
    ...C.money("amount", "Fee amount."),
    ...C.money("amount_refunded", "Amount of the fee refunded."),
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    C.bool("refunded", "Whether fully refunded."),
    C.ref("application", "Connect application id (ca_…)."),
    C.ref("originating_transaction", "Charge on the connected account that created the fee."),
    C.ref("balance_transaction", "Balance transaction id (txn_…)."),
    created("fee"),
    C.livemode(),
  ],
  examples: [
    {
      sql: `SELECT account, currency, sum(amount_decimal - amount_refunded_decimal) AS net_fees FROM ${Q}.application_fees() GROUP BY ALL ORDER BY account`,
      description: "Net platform fees per connected account",
    },
  ],
});

export const transfers = defineStripeTable({
  name: "transfers",
  description: "Connect transfers from the platform balance to connected accounts",
  title: "Transfers",
  category: "connect",
  keywords: "stripe, connect, transfers, payouts to sellers, marketplace, destination charges",
  docLlm:
    "Transfers (GET /v1/transfers): destination account, amount and amount_reversed (+ *_decimal), currency, " +
    "reversed, description, source_transaction, destination_payment, source_type, transfer_group, " +
    "balance_transaction, created and metadata.",
  docMd: "## transfers(expand := NULL)\n\nMoney sent to connected accounts.",
  pushdown: "`created` ranges, `destination`, `transfer_group` → list parameters.",
  path: "/v1/transfers",
  params: { destination: str("destination"), transfer_group: str("transfer_group") },
  ranges: CREATED,
  columns: [
    C.id("Transfer id (tr_…)."),
    C.ref("destination", "Connected account id (acct_…)."),
    ...C.money("amount", "Amount transferred."),
    ...C.money("amount_reversed", "Amount reversed."),
    C.str("currency", "Three-letter ISO currency code, lowercase."),
    C.bool("reversed", "Whether fully reversed."),
    C.str("description", "Description."),
    C.ref("source_transaction", "Charge id the transfer was funded from, if any."),
    C.ref("destination_payment", "Payment id created on the connected account (py_…)."),
    C.str("source_type", "card, bank_account or fpx."),
    C.str("transfer_group", "Transfer group."),
    C.ref("balance_transaction", "Balance transaction id (txn_…)."),
    created("transfer"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT destination, currency, sum(amount_decimal - amount_reversed_decimal) AS sent FROM ${Q}.transfers() GROUP BY ALL ORDER BY destination`,
      description: "Net amount transferred to each connected account",
    },
  ],
});

// -------------------------------------------------------------------- platform

export const events = defineStripeTable({
  name: "events",
  description: "Events: the account's change and audit feed (last 30 days)",
  title: "Events",
  category: "platform",
  keywords: "stripe, events, webhooks, audit log, change feed, activity, cdc",
  docLlm:
    "Events (GET /v1/events): every change Stripe recorded in the last 30 days — type (charge.succeeded, " +
    "customer.subscription.updated, invoice.paid …), created, object_type and object_id of the affected object, " +
    "data_object (the object's state after the change, JSON), previous_attributes (changed fields' old values, " +
    "JSON), api_version, request_id and idempotency_key (what API request caused it; NULL for automatic " +
    "changes), pending_webhooks and account (Connect). `starts_with(type, 'invoice.')` pushes down as the " +
    "`invoice.*` wildcard. object_id is filtered locally (Stripe cannot filter events by object).",
  docMd: "## events(expand := NULL)\n\nThe change feed: what happened to which object and when.",
  pushdown:
    "`created` ranges, `type` (=; IN → `types[]`; starts_with ending in '.' → `type=prefix.*`) → list " +
    "parameters. `object_id` / `object_type` are filtered locally.",
  path: "/v1/events",
  baseQuery: ({ constraints }) => {
    const p = prefixValue(constraints, "type");
    return p && /^[a-z_.]+\.$/.test(p) ? { type: `${p}*` } : {};
  },
  params: { type: { param: "type", kind: "string", arrayParam: "types" } },
  ranges: CREATED,
  columns: [
    C.id("Event id (evt_…)."),
    C.str("type", "Event type, e.g. charge.succeeded or customer.subscription.deleted."),
    created("event"),
    C.str("object_type", "Type of the affected object (charge, invoice, customer …).", "data.object.object"),
    C.str("object_id", "Id of the affected object.", "data.object.id"),
    C.json("data_object", "The affected object as of the event (secrets redacted).", "data.object"),
    C.json(
      "previous_attributes",
      "For *.updated events, the changed fields' previous values.",
      "data.previous_attributes",
    ),
    C.str("api_version", "API version used to render the event data."),
    C.str("request_id", "API request id that caused the event (NULL for automatic events).", "request.id"),
    C.str("idempotency_key", "Idempotency key of that request.", "request.idempotency_key"),
    C.int("pending_webhooks", "Webhook deliveries not yet successful."),
    C.str("account", "Connected account the event is for (Connect)."),
    C.livemode(),
  ],
  examples: [
    {
      sql: `SELECT type, count(*) AS events FROM ${Q}.events() WHERE created >= TIMESTAMPTZ '2026-11-01' GROUP BY type ORDER BY events DESC`,
      description: "Event volume by type since 1 November",
    },
    {
      sql: `SELECT created, type, object_id FROM ${Q}.events() WHERE starts_with(type, 'invoice.') ORDER BY created`,
      description: "Invoice events only (pushed down as the invoice.* wildcard)",
    },
  ],
});

/** Keep only the host of a webhook URL (paths and query strings can carry tokens). */
export function urlHost(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

export const webhookEndpoints = defineStripeTable({
  name: "webhook_endpoints",
  description: "Webhook endpoints: host, status and subscribed event types (no secrets, no URL paths)",
  title: "Webhook Endpoints",
  category: "platform",
  keywords: "stripe, webhooks, webhook endpoints, integrations, event subscriptions, audit",
  docLlm:
    "Webhook endpoints (GET /v1/webhook_endpoints): url_host (only the host — paths and query strings can carry " +
    "tokens and are dropped, also from raw), status (enabled, disabled), enabled_events, api_version, " +
    "application, description, created and metadata. Signing secrets are never returned.",
  docMd: "## webhook_endpoints(expand := NULL)\n\nWhere Stripe sends events (host only).",
  pushdown: "nothing (filters run locally).",
  path: "/v1/webhook_endpoints",
  transform: (r) => {
    const { url, secret: _secret, ...rest } = r;
    return { ...rest, url_host: urlHost(url) };
  },
  columns: [
    C.id("Webhook endpoint id (we_…)."),
    C.str("url_host", "Host of the endpoint URL (path and query dropped)."),
    C.str("status", "enabled or disabled."),
    C.strList("enabled_events", "Event types sent ('*' = all)."),
    C.str("api_version", "API version events are rendered with."),
    C.str("application", "Connect application id, for Connect endpoints."),
    C.str("description", "Description."),
    created("webhook endpoint"),
    C.livemode(),
    C.meta(),
  ],
  examples: [
    {
      sql: `SELECT url_host, status, len(enabled_events) AS event_types FROM ${Q}.webhook_endpoints() ORDER BY url_host`,
      description: "Webhook endpoints and how many event types each receives",
    },
  ],
});

const FILE_PURPOSES = [
  "account_requirement",
  "additional_verification",
  "business_icon",
  "business_logo",
  "customer_signature",
  "dispute_evidence",
  "document_provider_identity_document",
  "finance_report_run",
  "financial_account_statement",
  "identity_document",
  "identity_document_downloadable",
  "issuing_regulatory_reporting",
  "pci_document",
  "platform_terms_of_service",
  "selfie",
  "sigma_scheduled_query",
  "tax_document_user_upload",
  "terminal_android_apk",
  "terminal_reader_splashscreen",
  "terminal_wifi_certificate",
  "terminal_wifi_private_key",
] as const;

export const files = defineStripeTable({
  name: "files",
  description: "Files uploaded to or generated by Stripe (metadata only, not contents)",
  title: "Files",
  category: "platform",
  keywords: "stripe, files, uploads, dispute evidence, reports, documents",
  docLlm:
    "File metadata (GET /v1/files): purpose (dispute_evidence, identity_document, finance_report_run, " +
    "sigma_scheduled_query …), filename, title, type (pdf, csv, png …), size in bytes, expires_at, url (needs " +
    "your API key to download) and created. File contents are not downloaded.",
  docMd: "## files(expand := NULL)\n\nFiles held by Stripe (metadata).",
  pushdown: "`created` ranges, `purpose` → list parameters.",
  path: "/v1/files",
  params: { purpose: choice("purpose", FILE_PURPOSES) },
  ranges: CREATED,
  columns: [
    C.id("File id (file_…)."),
    C.str("purpose", "dispute_evidence, identity_document, finance_report_run, …"),
    C.str("filename", "Original file name."),
    C.str("title", "Title."),
    C.str("type", "File type: pdf, csv, png, jpg, …"),
    C.int("size", "Size in bytes."),
    C.time("expires_at", "When the file expires."),
    C.str("url", "API URL for the contents (requires your key)."),
    created("file"),
  ],
  examples: [
    {
      sql: `SELECT purpose, count(*) AS files, sum(size) AS bytes FROM ${Q}.files() GROUP BY purpose ORDER BY purpose`,
      description: "Files by purpose and total size",
    },
  ],
});

export const FUNCTIONS: VgiFunction[] = [
  balance,
  balanceTransactions,
  payouts,
  charges,
  paymentIntents,
  refunds,
  disputes,
  earlyFraudWarnings,
  checkoutSessions,
  customers,
  paymentMethods,
  invoices,
  invoiceLineItems,
  invoiceItems,
  subscriptions,
  subscriptionItems,
  subscriptionSchedules,
  creditNotes,
  billingMeters,
  meterEventSummaries,
  products,
  prices,
  coupons,
  promotionCodes,
  taxRates,
  accounts,
  applicationFees,
  transfers,
  events,
  webhookEndpoints,
  files,
];
