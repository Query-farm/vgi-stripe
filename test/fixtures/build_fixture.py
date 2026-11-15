#!/usr/bin/env python3
"""Build the offline Stripe account the replay server serves (stdlib only, deterministic).

    python3 test/fixtures/build_fixture.py > test/fixtures/stripe-account.json

Every object uses only fields that exist in Stripe's OpenAPI spec for its type (the
replay server checks this against stripe-openapi-subset.json at start-up), in the
shapes of API version 2026-09-30 (e.g. an invoice's subscription under
``parent.subscription_details``, a subscription's period on its items).

Times are fixed: T0 = 2026-11-01T00:00:00Z.
"""

from __future__ import annotations

import datetime as dt
import json
import sys

T0 = int(dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc).timestamp())
DAY = 86400
HOUR = 3600


def t(days: float = 0, hours: float = 0) -> int:
    return int(T0 + days * DAY + hours * HOUR)


def fee_for(amount: int) -> int:
    return round(amount * 0.029) + 30


def card(brand, last4, month, year, funding="credit", country="US", wallet=None):
    c = {"brand": brand, "last4": last4, "exp_month": month, "exp_year": year, "funding": funding,
         "country": country, "fingerprint": f"fp_{brand}_{last4}", "display_brand": brand}
    c["wallet"] = {"type": wallet} if wallet else None
    return c


def address(country, city=None, postal=None, state=None):
    return {"country": country, "city": city, "postal_code": postal, "state": state, "line1": None, "line2": None}


customers = [
    ("cus_ada", "ada@example.com", "Ada Lovelace", "+44 20 7946 0000", "gbp", -500, address("GB", "London", "EC1A 1BB"),
     t(-30), {"plan": "pro", "segment": "enterprise"}, False),
    ("cus_grace", "grace@example.com", "Grace Hopper", "+1 212 555 0100", "usd", 0, address("US", "New York", "10001", "NY"),
     t(-20), {"plan": "basic"}, False),
    ("cus_alan", "alan@example.com", "Alan Turing", None, "jpy", 0, address("JP", "Tokyo", "100-0001"), t(-10), {}, False),
    ("cus_kat", "kat@example.com", "Katherine Johnson", None, "kwd", 0, address("KW", "Kuwait City"), t(-5),
     {"plan": "pro"}, True),
    ("cus_margaret", "Margaret@Example.com", "Margaret Hamilton", None, "usd", 0, address("US", "Boston", "02108", "MA"),
     t(-2), {"plan": "basic"}, False),
    ("cus_radia", None, "Radia Perlman", None, "eur", 0, address("DE", "Berlin", "10115"), t(-1), {}, False),
]
CUSTOMERS = []
for cid, email, name, phone, cur, bal, addr, created, meta, delinquent in customers:
    CUSTOMERS.append({
        "id": cid, "object": "customer", "email": email, "name": name, "phone": phone, "currency": cur,
        "balance": bal, "address": addr, "created": created, "metadata": meta, "delinquent": delinquent,
        "description": None, "default_source": None, "invoice_prefix": cid.upper()[4:8],
        "invoice_settings": {"default_payment_method": None, "custom_fields": None, "footer": None,
                             "rendering_options": None},
        "livemode": False, "preferred_locales": ["en"], "tax_exempt": "none", "test_clock": None,
        "shipping": None, "next_invoice_sequence": 1, "discount": None,
    })

PAYMENT_METHODS = []
for pid, cust, kind, c, created in [
    ("pm_ada_visa", "cus_ada", "card", card("visa", "4242", 12, 2027, country="GB", wallet="apple_pay"), t(-30)),
    ("pm_ada_amex", "cus_ada", "card", card("amex", "0005", 3, 2026), t(-29)),
    ("pm_grace_mc", "cus_grace", "card", card("mastercard", "4444", 8, 2026, funding="debit"), t(-20)),
    ("pm_alan_jcb", "cus_alan", "card", card("jcb", "0000", 1, 2028, country="JP"), t(-10)),
    ("pm_kat_visa", "cus_kat", "card", card("visa", "1881", 6, 2029, country="KW"), t(-5)),
    ("pm_margaret_visa", "cus_margaret", "card", card("visa", "0341", 9, 2025), t(-2)),
    ("pm_radia_sepa", "cus_radia", "sepa_debit", None, t(-1)),
]:
    pm = {"id": pid, "object": "payment_method", "type": kind, "customer": cust, "created": created,
          "livemode": False, "metadata": {}, "allow_redisplay": "always",
          "billing_details": {"name": next(x["name"] for x in CUSTOMERS if x["id"] == cust),
                              "email": next(x["email"] for x in CUSTOMERS if x["id"] == cust),
                              "phone": None, "address": None, "tax_id": None}}
    if c:
        pm["card"] = c
    else:
        pm["sepa_debit"] = {"bank_code": "37040044", "country": "DE", "last4": "3000", "fingerprint": "fp_sepa",
                            "branch_code": None, "generated_from": None}
    PAYMENT_METHODS.append(pm)
PM_BY_CUSTOMER = {}
for pm in PAYMENT_METHODS:
    PM_BY_CUSTOMER.setdefault(pm["customer"], pm)

# id, customer, amount, currency, status, day, refunded_amount, failure, disputed, extra
charge_rows = [
    ("ch_1", "cus_ada", 2000, "gbp", "succeeded", 1, 0, None, False, {}),
    ("ch_2", "cus_grace", 5000, "usd", "succeeded", 2, 1500, None, True, {}),
    ("ch_3", "cus_grace", 1200, "usd", "failed", 3, 0, ("card_declined", "Your card was declined."), False, {}),
    ("ch_4", "cus_alan", 3000, "jpy", "succeeded", 3.5, 0, None, False, {}),
    ("ch_5", "cus_kat", 1500, "kwd", "succeeded", 4, 0, None, True, {}),
    ("ch_6", "cus_ada", 9900, "gbp", "succeeded", 5, 9900, None, False, {}),
    ("ch_7", "cus_margaret", 2500, "usd", "pending", 6, 0, None, False, {}),
    ("ch_8", "cus_radia", 4200, "eur", "succeeded", 6.5, 1000, None, False, {"metadata": {"order_id": "6735"}}),
    ("ch_9", "cus_grace", 700, "usd", "failed", 7, 0, ("expired_card", "Your card has expired."), False, {}),
    ("ch_10", "cus_ada", 2000, "usd", "succeeded", 8, 0, None, False, {"transfer_group": "order_42"}),
]
CHARGES, PAYMENT_INTENTS, BALANCE_TRANSACTIONS = [], [], []
for cid, cust, amount, cur, status, day, refunded, failure, disputed, extra in charge_rows:
    n = cid.split("_")[1]
    pm = PM_BY_CUSTOMER[cust]
    created = t(day)
    txn = f"txn_{cid}" if status != "failed" else None
    card_details = dict(pm["card"]) if "card" in pm else None
    risk = {"ch_5": ("elevated", 65), "ch_3": ("normal", 30)}.get(cid, ("normal", 12))
    outcome = {
        "type": "issuer_declined" if status == "failed" else "authorized",
        "network_status": "declined_by_network" if status == "failed" else "approved_by_network",
        "reason": "generic_decline" if status == "failed" else None,
        "risk_level": risk[0], "risk_score": risk[1],
        "seller_message": "The bank declined the payment." if status == "failed" else "Payment complete.",
        "advice_code": None, "network_advice_code": None, "network_decline_code": None, "rule": None,
    }
    pmd = {"type": pm["type"]}
    if card_details:
        pmd["card"] = {k: card_details[k] for k in ("brand", "last4", "exp_month", "exp_year", "funding", "country",
                                                    "fingerprint", "wallet")}
    else:
        pmd["sepa_debit"] = {"last4": "3000", "country": "DE", "bank_code": "37040044", "branch_code": None,
                             "fingerprint": "fp_sepa", "mandate": None}
    ch = {
        "id": cid, "object": "charge", "amount": amount, "amount_captured": amount if status == "succeeded" else 0,
        "amount_refunded": refunded, "currency": cur, "customer": cust, "payment_intent": f"pi_{n}",
        "payment_method": pm["id"], "payment_method_details": pmd, "status": status,
        "captured": status == "succeeded", "paid": status == "succeeded", "refunded": refunded == amount and amount > 0,
        "disputed": disputed, "failure_code": failure[0] if failure else None,
        "failure_message": failure[1] if failure else None, "outcome": outcome,
        "billing_details": {**pm["billing_details"], "address": address(
            next(x["address"]["country"] for x in CUSTOMERS if x["id"] == cust), None,
            next(x["address"]["postal_code"] for x in CUSTOMERS if x["id"] == cust))},
        "receipt_email": pm["billing_details"]["email"], "receipt_url": f"https://pay.stripe.com/receipts/{cid}",
        "receipt_number": None, "description": f"Order {n}", "statement_descriptor": None,
        "calculated_statement_descriptor": "QUERYFARM", "application_fee_amount": None,
        "transfer_group": None, "balance_transaction": txn, "created": created, "livemode": False, "metadata": {},
        "on_behalf_of": None, "review": None, "shipping": None, "transfer_data": None, "fraud_details": {},
    }
    ch.update(extra)
    CHARGES.append(ch)
    pi_status = {"succeeded": "succeeded", "pending": "processing", "failed": "requires_payment_method"}[status]
    PAYMENT_INTENTS.append({
        "id": f"pi_{n}", "object": "payment_intent", "amount": amount,
        "amount_received": amount if status == "succeeded" else 0, "amount_capturable": 0, "currency": cur,
        "customer": cust, "latest_charge": cid, "payment_method": pm["id"], "payment_method_types": [pm["type"]],
        "status": pi_status, "capture_method": "automatic_async", "confirmation_method": "automatic",
        "setup_future_usage": None, "cancellation_reason": None, "canceled_at": None,
        "last_payment_error": {"code": failure[0], "decline_code": "generic_decline", "message": failure[1],
                               "type": "card_error"} if failure else None,
        "description": f"Order {n}", "receipt_email": None, "statement_descriptor": None,
        "application_fee_amount": None, "transfer_group": ch["transfer_group"], "created": created - 60,
        "livemode": False, "metadata": ch["metadata"], "client_secret": f"pi_{n}_secret_doNotLeak{n}",
    })
    if txn:
        fee = fee_for(amount)
        BALANCE_TRANSACTIONS.append({
            "id": txn, "object": "balance_transaction", "type": "charge", "reporting_category": "charge",
            "status": "pending" if status == "pending" or day > 6 else "available", "amount": amount, "fee": fee,
            "net": amount - fee, "currency": cur, "exchange_rate": None, "description": f"Order {n}",
            "source": cid, "balance_type": "payments", "created": created, "available_on": created + 2 * DAY,
            "fee_details": [{"amount": fee, "application": None, "currency": cur, "description": "Stripe processing fees",
                             "type": "stripe_fee"}],
        })
PAYMENT_INTENTS.append({
    "id": "pi_11", "object": "payment_intent", "amount": 4900, "amount_received": 0, "amount_capturable": 0,
    "currency": "gbp", "customer": "cus_ada", "latest_charge": None, "payment_method": None,
    "payment_method_types": ["card", "link"], "status": "canceled", "capture_method": "automatic_async",
    "confirmation_method": "automatic", "setup_future_usage": None, "cancellation_reason": "abandoned",
    "canceled_at": t(9), "last_payment_error": None, "description": "Abandoned cart", "receipt_email": None,
    "statement_descriptor": None, "application_fee_amount": None, "transfer_group": None, "created": t(8.5),
    "livemode": False, "metadata": {"cart": "c_77"}, "client_secret": "pi_11_secret_doNotLeak11",
})

REFUNDS = []
for rid, ch, amount, cur, reason, status, day in [
    ("re_1", "ch_2", 1500, "usd", "requested_by_customer", "succeeded", 2.5),
    ("re_2", "ch_6", 9900, "gbp", "duplicate", "succeeded", 5.5),
    ("re_3", "ch_8", 1000, "eur", "fraudulent", "pending", 7),
]:
    txn = f"txn_{rid}"
    REFUNDS.append({
        "id": rid, "object": "refund", "amount": amount, "currency": cur, "charge": ch,
        "payment_intent": "pi_" + ch.split("_")[1], "reason": reason, "status": status, "failure_reason": None,
        "receipt_number": None, "description": None, "balance_transaction": txn, "created": t(day), "metadata": {},
    })
    BALANCE_TRANSACTIONS.append({
        "id": txn, "object": "balance_transaction", "type": "refund", "reporting_category": "refund",
        "status": "available", "amount": -amount, "fee": 0, "net": -amount, "currency": cur, "exchange_rate": None,
        "description": f"REFUND FOR CHARGE ({ch})", "source": rid, "balance_type": "payments", "created": t(day),
        "available_on": t(day), "fee_details": [],
    })

DISPUTES = [
    {"id": "dp_1", "object": "dispute", "amount": 1500, "currency": "kwd", "charge": "ch_5", "payment_intent": "pi_5",
     "reason": "fraudulent", "status": "needs_response", "is_charge_refundable": False, "created": t(9),
     "evidence_details": {"due_by": t(20), "has_evidence": False, "past_due": False, "submission_count": 0,
                          "enhanced_eligibility": {}},
     "payment_method_details": {"type": "card", "card": {"brand": "visa", "network_reason_code": "10.4",
                                                          "case_type": "chargeback"}},
     "livemode": False, "metadata": {}},
    {"id": "dp_2", "object": "dispute", "amount": 5000, "currency": "usd", "charge": "ch_2", "payment_intent": "pi_2",
     "reason": "product_not_received", "status": "won", "is_charge_refundable": False, "created": t(4),
     "evidence_details": {"due_by": t(14), "has_evidence": True, "past_due": False, "submission_count": 1,
                          "enhanced_eligibility": {}},
     "payment_method_details": {"type": "card", "card": {"brand": "mastercard", "network_reason_code": "4855",
                                                          "case_type": "chargeback"}},
     "livemode": False, "metadata": {"case": "A-12"}},
]

PAYOUTS = []
PAYOUT_CONTENTS = {"po_1": ["txn_ch_2", "txn_re_1", "txn_po_1"], "po_2": ["txn_ch_1", "txn_po_2"]}
for pid, amount, cur, status, arrival, created, failure in [
    ("po_1", 3200, "usd", "paid", 5, 3, None),
    ("po_2", 1600, "gbp", "in_transit", 9, 7, None),
    ("po_3", 1000, "usd", "failed", 8, 6, ("account_closed", "The bank account has been closed.")),
]:
    PAYOUTS.append({
        "id": pid, "object": "payout", "amount": amount, "currency": cur, "status": status, "arrival_date": t(arrival),
        "automatic": pid != "po_3", "method": "standard", "type": "bank_account", "destination": "ba_main",
        "balance_transaction": f"txn_{pid}", "failure_code": failure[0] if failure else None,
        "failure_message": failure[1] if failure else None, "reconciliation_status":
            "completed" if status == "paid" else "in_progress", "source_type": "card",
        "statement_descriptor": "QUERYFARM", "description": "STRIPE PAYOUT", "created": t(created), "livemode": False,
        "metadata": {},
    })
    BALANCE_TRANSACTIONS.append({
        "id": f"txn_{pid}", "object": "balance_transaction", "type": "payout", "reporting_category": "payout",
        "status": "available", "amount": -amount, "fee": 0, "net": -amount, "currency": cur, "exchange_rate": None,
        "description": "STRIPE PAYOUT", "source": pid, "balance_type": "payments", "created": t(created),
        "available_on": t(created), "fee_details": [],
    })
BALANCE_TRANSACTIONS.append({
    "id": "txn_tr_1", "object": "balance_transaction", "type": "transfer", "reporting_category": "transfer",
    "status": "available", "amount": -1600, "fee": 0, "net": -1600, "currency": "usd", "exchange_rate": None,
    "description": None, "source": "tr_1", "balance_type": "payments", "created": t(8.1), "available_on": t(8.1),
    "fee_details": [],
})
BALANCE_TRANSACTIONS.append({
    "id": "txn_fee_billing", "object": "balance_transaction", "type": "stripe_fee", "reporting_category": "fee",
    "status": "available", "amount": -250, "fee": 0, "net": -250, "currency": "usd", "exchange_rate": None,
    "description": "Billing (2026-10)", "source": None, "balance_type": "payments", "created": t(1.2),
    "available_on": t(1.2), "fee_details": [],
})

PRODUCTS = []
for pid, name, active, desc, default_price, shippable, unit_label, created in [
    ("prod_pro", "Pro Plan", True, "Everything in Basic plus priority support", "price_pro_monthly", None, "seat", -60),
    ("prod_basic", "Basic Plan", True, "Core analytics", "price_basic_monthly", None, "seat", -60),
    ("prod_api", "API Calls", True, "Metered API usage", "price_api", None, "call", -45),
    ("prod_legacy", "Legacy Widget", False, "Discontinued hardware widget", "price_widget", True, None, -400),
]:
    PRODUCTS.append({
        "id": pid, "object": "product", "name": name, "active": active, "description": desc,
        "default_price": default_price, "shippable": shippable, "unit_label": unit_label,
        "url": f"https://query.farm/{pid[5:]}" if pid != "prod_legacy" else None,
        "tax_code": "txcd_10103001", "statement_descriptor": None, "images": [], "created": t(created),
        "updated": t(created + 1), "livemode": False, "metadata": {"tier": pid[5:]},
        "marketing_features": [], "package_dimensions": None,
    })

PRICES = []
for pid, product, cur, amount, amount_dec, interval, active, lookup, usage, meter in [
    ("price_pro_monthly", "prod_pro", "gbp", 2900, "2900", "month", True, "pro_monthly", "licensed", None),
    ("price_pro_yearly", "prod_pro", "gbp", 29000, "29000", "year", True, "pro_yearly", "licensed", None),
    ("price_pro_jpy", "prod_pro", "jpy", 3000, "3000", "month", True, None, "licensed", None),
    ("price_basic_monthly", "prod_basic", "usd", 1500, "1500", "month", True, "basic_monthly", "licensed", None),
    ("price_api", "prod_api", "usd", None, "0.25", "month", True, "api_calls", "metered", "mtr_api_calls"),
    ("price_widget", "prod_legacy", "usd", 1999, "1999", None, False, None, None, None),
]:
    PRICES.append({
        "id": pid, "object": "price", "product": product, "currency": cur, "unit_amount": amount,
        "unit_amount_decimal": amount_dec, "type": "recurring" if interval else "one_time",
        "billing_scheme": "per_unit", "active": active, "lookup_key": lookup, "nickname": None,
        "recurring": {"interval": interval, "interval_count": 1, "usage_type": usage, "meter": meter,
                      "trial_period_days": None} if interval else None,
        "tax_behavior": "exclusive", "tiers_mode": None, "created": t(-60), "livemode": False, "metadata": {},
        "custom_unit_amount": None, "transform_quantity": None,
    })
PRICE = {p["id"]: p for p in PRICES}

# Subscriptions with their items (embedded list; sub_margaret embeds 1 of 2 items with has_more).
SUBSCRIPTIONS, SUBSCRIPTION_ITEMS = [], []
for sid, cust, status, items, created, extra in [
    ("sub_ada", "cus_ada", "active", [("price_pro_monthly", 3)], -30, {"schedule": "sub_sched_1"}),
    ("sub_grace", "cus_grace", "trialing", [("price_basic_monthly", 1)], -20, {"trial_start": t(-20), "trial_end": t(10)}),
    ("sub_alan", "cus_alan", "canceled", [("price_pro_jpy", 1)], -10, {
        "canceled_at": t(-3), "ended_at": t(-3),
        "cancellation_details": {"reason": "cancellation_requested", "feedback": "too_expensive", "comment": None}}),
    ("sub_kat", "cus_kat", "past_due", [("price_pro_monthly", 1)], -5, {}),
    ("sub_margaret", "cus_margaret", "active", [("price_basic_monthly", 2), ("price_api", None)], -2,
     {"cancel_at_period_end": True, "cancel_at": t(28)}),
    ("sub_radia", "cus_radia", "incomplete", [("price_basic_monthly", 1)], -1, {}),
]:
    item_objs = []
    for i, (price, qty) in enumerate(items):
        si = {"id": f"si_{sid[4:]}_{i + 1}", "object": "subscription_item", "subscription": sid, "price": PRICE[price],
              "quantity": qty, "created": t(created), "current_period_start": t(created + 30 * (created < -29)),
              "current_period_end": t(created + 30 + 30 * (created < -29)), "metadata": {}, "discounts": [],
              "tax_rates": [], "billing_thresholds": None}
        item_objs.append(si)
        SUBSCRIPTION_ITEMS.append(si)
    embed = item_objs[:1] if sid == "sub_margaret" else item_objs
    sub = {
        "id": sid, "object": "subscription", "customer": cust, "status": status, "currency": PRICE[items[0][0]]["currency"],
        "collection_method": "charge_automatically", "created": t(created), "start_date": t(created),
        "billing_cycle_anchor": t(created), "cancel_at_period_end": False, "cancel_at": None, "canceled_at": None,
        "ended_at": None, "trial_start": None, "trial_end": None,
        "cancellation_details": {"reason": None, "feedback": None, "comment": None}, "days_until_due": None,
        "default_payment_method": PM_BY_CUSTOMER[cust]["id"], "latest_invoice": None, "schedule": None,
        "description": None, "test_clock": None, "livemode": False, "metadata": {"source": "web"},
        "items": {"object": "list", "data": embed, "has_more": len(embed) < len(item_objs),
                  "total_count": len(item_objs), "url": f"/v1/subscription_items?subscription={sid}"},
    }
    sub.update(extra)
    SUBSCRIPTIONS.append(sub)

INVOICES, INVOICE_LINES = [], []


def line(lid, invoice, amount, cur, desc, price=None, sub=None, si=None, ii=None, qty=1, start=0, end=30):
    parent = None
    if si:
        parent = {"type": "subscription_item_details", "subscription_item_details": {
            "subscription": sub, "subscription_item": si, "proration": False, "invoice_item": None,
            "proration_details": {"credited_items": None}}, "invoice_item_details": None}
    elif ii:
        parent = {"type": "invoice_item_details", "invoice_item_details": {
            "invoice_item": ii, "proration": False, "subscription": None, "proration_details": {"credited_items": None}},
            "subscription_item_details": None}
    p = PRICE.get(price) if price else None
    return {
        "id": lid, "object": "line_item", "invoice": invoice, "amount": amount, "currency": cur, "description": desc,
        "quantity": qty, "period": {"start": t(start), "end": t(end)}, "discountable": True, "livemode": False,
        "metadata": {}, "subscription": sub, "parent": parent, "discount_amounts": [], "discounts": [],
        "pretax_credit_amounts": [], "taxes": [], "subtotal": amount,
        "pricing": {"type": "price_details", "price_details": {"price": price, "product": p["product"] if p else None},
                    "unit_amount_decimal": p["unit_amount_decimal"] if p else str(amount)},
    }


for iid, cust, status, cur, lines, sub, created, due, extra in [
    ("in_1", "cus_ada", "paid", "gbp",
     [line("il_1", "in_1", 8700, "gbp", "3 × Pro Plan", "price_pro_monthly", "sub_ada", "si_ada_1", qty=3)],
     "sub_ada", 0, None, {"number": "ADA-0001", "status_transitions": {"finalized_at": t(0, 1), "paid_at": t(0, 2),
                                                                      "voided_at": None, "marked_uncollectible_at": None}}),
    ("in_2", "cus_grace", "open", "usd",
     [line("il_2", "in_2", 1500, "usd", "Basic Plan", "price_basic_monthly", "sub_grace", "si_grace_1"),
      line("il_3", "in_2", 3000, "usd", "Onboarding fee", ii="ii_1")],
     "sub_grace", 1, 15, {"number": "GRA-0001", "collection_method": "send_invoice"}),
    ("in_3", "cus_kat", "uncollectible", "kwd",
     [line("il_4", "in_3", 2900, "kwd", "Pro Plan", "price_pro_monthly", "sub_kat", "si_kat_1")],
     "sub_kat", 2, None, {"number": "KAT-0001", "attempt_count": 4}),
    ("in_4", "cus_alan", "draft", "jpy", [line("il_5", "in_4", 3000, "jpy", "Pro Plan (JPY)", "price_pro_jpy",
                                                "sub_alan", "si_alan_1")],
     "sub_alan", 3, None, {"number": None}),
    ("in_5", "cus_grace", "void", "usd", [line("il_6", "in_5", 1500, "usd", "Basic Plan", "price_basic_monthly")],
     None, 4, None, {"number": "GRA-0002"}),
    ("in_6", "cus_margaret", "open", "usd",
     [line("il_7", "in_6", 1500, "usd", "Basic Plan", "price_basic_monthly", "sub_margaret", "si_margaret_1"),
      line("il_8", "in_6", 1500, "usd", "Basic Plan (seat 2)", "price_basic_monthly", "sub_margaret", "si_margaret_1"),
      line("il_9", "in_6", 250, "usd", "API calls (1000 × $0.0025)", "price_api", "sub_margaret", "si_margaret_2",
           qty=1000),
      line("il_10", "in_6", 500, "usd", "Rush support", ii="ii_3")],
     "sub_margaret", 5, None, {"number": "MAR-0001"}),
]:
    total = sum(x["amount"] for x in lines)
    paid = total if status == "paid" else 0
    embed = lines[:2] if iid == "in_6" else lines
    INVOICE_LINES.extend(lines)
    inv = {
        "id": iid, "object": "invoice", "customer": cust, "status": status, "currency": cur,
        "customer_email": next(x["email"] for x in CUSTOMERS if x["id"] == cust),
        "customer_name": next(x["name"] for x in CUSTOMERS if x["id"] == cust),
        "collection_method": "charge_automatically", "billing_reason": "subscription_cycle" if sub else "manual",
        "total": total, "subtotal": total, "amount_due": total, "amount_paid": paid,
        "amount_remaining": 0 if status in ("paid", "void") else total - paid, "attempt_count": 1 if status != "draft" else 0,
        "attempted": status != "draft", "auto_advance": status in ("draft", "open"),
        "due_date": t(due) if due is not None else None, "period_start": t(created - 30), "period_end": t(created),
        "status_transitions": {"finalized_at": None if status == "draft" else t(created, 1),
                               "paid_at": None, "voided_at": t(created, 3) if status == "void" else None,
                               "marked_uncollectible_at": t(created, 5) if status == "uncollectible" else None},
        "next_payment_attempt": t(created + 3) if status == "open" else None,
        "hosted_invoice_url": f"https://invoice.stripe.com/i/{iid}", "invoice_pdf": f"https://pay.stripe.com/invoice/{iid}/pdf",
        "receipt_number": "2145-0001" if status == "paid" else None, "description": None,
        "created": t(created), "livemode": False, "metadata": {},
        "parent": {"type": "subscription_details", "quote_details": None,
                   "subscription_details": {"subscription": sub, "metadata": {}, "subscription_proration_date": None}}
        if sub else None,
        "lines": {"object": "list", "data": embed, "has_more": len(embed) < len(lines), "total_count": len(lines),
                  "url": f"/v1/invoices/{iid}/lines"},
    }
    inv.update(extra)
    INVOICES.append(inv)

INVOICE_ITEMS = []
for iid, cust, invoice, amount, cur, desc, day in [
    ("ii_1", "cus_grace", "in_2", 3000, "usd", "Onboarding fee", 0.5),
    ("ii_2", "cus_ada", None, 1000, "gbp", "Extra seat (pending)", 6),
    ("ii_3", "cus_margaret", "in_6", 500, "usd", "Rush support", 4),
    ("ii_4", "cus_margaret", None, 750, "usd", "Training session (pending)", 7),
]:
    INVOICE_ITEMS.append({
        "id": iid, "object": "invoiceitem", "customer": cust, "invoice": invoice, "amount": amount, "currency": cur,
        "description": desc, "quantity": 1, "date": t(day), "period": {"start": t(day), "end": t(day)},
        "proration": False, "discountable": True, "livemode": False, "metadata": {}, "discounts": [],
        "parent": None, "test_clock": None,
        "pricing": {"type": "price_details", "price_details": None, "unit_amount_decimal": str(amount)},
    })

SUBSCRIPTION_SCHEDULES = [
    {"id": "sub_sched_1", "object": "subscription_schedule", "customer": "cus_ada", "subscription": "sub_ada",
     "status": "active", "end_behavior": "release", "current_phase": {"start_date": t(-30), "end_date": t(30)},
     "phases": [{"start_date": t(-30), "end_date": t(30), "items": [{"price": "price_pro_monthly", "quantity": 3}]},
                {"start_date": t(30), "end_date": t(395), "items": [{"price": "price_pro_yearly", "quantity": 3}]}],
     "canceled_at": None, "completed_at": None, "released_at": None, "released_subscription": None,
     "created": t(-30), "livemode": False, "metadata": {}},
    {"id": "sub_sched_2", "object": "subscription_schedule", "customer": "cus_grace", "subscription": None,
     "status": "not_started", "end_behavior": "cancel", "current_phase": None,
     "phases": [{"start_date": t(40), "end_date": t(70), "items": [{"price": "price_basic_monthly", "quantity": 5}]}],
     "canceled_at": None, "completed_at": None, "released_at": None, "released_subscription": None,
     "created": t(6), "livemode": False, "metadata": {}},
]

COUPONS = [
    {"id": "SUMMER25", "object": "coupon", "name": "Summer 25%", "percent_off": 25.0, "amount_off": None,
     "currency": None, "duration": "repeating", "duration_in_months": 3, "max_redemptions": 100,
     "times_redeemed": 4, "redeem_by": t(60), "valid": True, "created": t(-50), "livemode": False, "metadata": {}},
    {"id": "WELCOME10", "object": "coupon", "name": "Welcome $10", "percent_off": None, "amount_off": 1000,
     "currency": "usd", "duration": "once", "duration_in_months": None, "max_redemptions": None,
     "times_redeemed": 9, "redeem_by": None, "valid": True, "created": t(-40), "livemode": False, "metadata": {}},
    {"id": "OLDPROMO", "object": "coupon", "name": "Launch 50%", "percent_off": 50.0, "amount_off": None,
     "currency": None, "duration": "forever", "duration_in_months": None, "max_redemptions": 10,
     "times_redeemed": 10, "redeem_by": t(-100), "valid": False, "created": t(-300), "livemode": False, "metadata": {}},
]

PROMOTION_CODES = [
    {"id": "promo_1", "object": "promotion_code", "code": "SUMMER25", "promotion": {"type": "coupon", "coupon": "SUMMER25"},
     "active": True, "customer": None, "expires_at": t(60), "max_redemptions": None, "times_redeemed": 4,
     "restrictions": {"first_time_transaction": False, "minimum_amount": None, "minimum_amount_currency": None,
                      "currency_options": {}}, "created": t(-50), "livemode": False, "metadata": {}},
    {"id": "promo_2", "object": "promotion_code", "code": "WELCOME", "promotion": {"type": "coupon", "coupon": "WELCOME10"},
     "active": True, "customer": None, "expires_at": None, "max_redemptions": 500, "times_redeemed": 9,
     "restrictions": {"first_time_transaction": True, "minimum_amount": 2000, "minimum_amount_currency": "usd",
                      "currency_options": {}}, "created": t(-40), "livemode": False, "metadata": {}},
    {"id": "promo_3", "object": "promotion_code", "code": "ADAONLY", "promotion": {"type": "coupon", "coupon": "OLDPROMO"},
     "active": False, "customer": "cus_ada", "expires_at": t(-100), "max_redemptions": 1, "times_redeemed": 1,
     "restrictions": {"first_time_transaction": False, "minimum_amount": None, "minimum_amount_currency": None,
                      "currency_options": {}}, "created": t(-200), "livemode": False, "metadata": {}},
]

CREDIT_NOTES = [
    {"id": "cn_1", "object": "credit_note", "number": "ADA-0001-CN-01", "status": "issued", "type": "post_payment",
     "reason": "product_unsatisfactory", "customer": "cus_ada", "invoice": "in_1", "currency": "gbp", "amount": 500,
     "subtotal": 500, "total": 500, "out_of_band_amount": None, "memo": "Goodwill credit", "effective_at": t(2),
     "voided_at": None, "pdf": "https://pay.stripe.com/credit_notes/cn_1/pdf", "created": t(2), "livemode": False,
     "metadata": {}},
    {"id": "cn_2", "object": "credit_note", "number": "GRA-0001-CN-01", "status": "void", "type": "pre_payment",
     "reason": "duplicate", "customer": "cus_grace", "invoice": "in_2", "currency": "usd", "amount": 1500,
     "subtotal": 1500, "total": 1500, "out_of_band_amount": None, "memo": None, "effective_at": t(3),
     "voided_at": t(3.5), "pdf": "https://pay.stripe.com/credit_notes/cn_2/pdf", "created": t(3), "livemode": False,
     "metadata": {}},
]

TAX_RATES = [
    {"id": "txr_vat_gb", "object": "tax_rate", "display_name": "VAT", "description": "UK VAT", "percentage": 20.0,
     "effective_percentage": 20.0, "inclusive": True, "active": True, "country": "GB", "state": None,
     "jurisdiction": "GB", "jurisdiction_level": "country", "tax_type": "vat", "rate_type": "percentage",
     "flat_amount": None, "created": t(-90), "livemode": False, "metadata": {}},
    {"id": "txr_ca", "object": "tax_rate", "display_name": "Sales Tax", "description": "California", "percentage": 7.25,
     "effective_percentage": 7.25, "inclusive": False, "active": True, "country": "US", "state": "CA",
     "jurisdiction": "US - CA", "jurisdiction_level": "state", "tax_type": "sales_tax", "rate_type": "percentage",
     "flat_amount": None, "created": t(-80), "livemode": False, "metadata": {}},
    {"id": "txr_de_old", "object": "tax_rate", "display_name": "MwSt", "description": "Germany (old)", "percentage": 19.0,
     "effective_percentage": None, "inclusive": True, "active": False, "country": "DE", "state": None,
     "jurisdiction": "DE", "jurisdiction_level": "country", "tax_type": "vat", "rate_type": "percentage",
     "flat_amount": None, "created": t(-500), "livemode": False, "metadata": {}},
]

CHECKOUT_SESSIONS = []
for sid, cust, status, mode, pay_status, subtotal, cur, pi, sub, day in [
    ("cs_1", "cus_ada", "complete", "payment", "paid", 2000, "gbp", "pi_1", None, 1),
    ("cs_2", "cus_grace", "expired", "payment", "unpaid", 5900, "usd", None, None, 2),
    ("cs_3", "cus_margaret", "open", "subscription", "unpaid", 1500, "usd", None, None, 8),
    ("cs_4", "cus_grace", "complete", "subscription", "paid", 1500, "usd", None, "sub_grace", -20),
]:
    c = next(x for x in CUSTOMERS if x["id"] == cust)
    CHECKOUT_SESSIONS.append({
        "id": sid, "object": "checkout.session", "customer": cust, "status": status, "mode": mode,
        "payment_status": pay_status, "amount_subtotal": subtotal, "amount_total": subtotal, "currency": cur,
        "customer_email": None, "customer_details": {"email": c["email"], "name": c["name"], "phone": None,
                                                      "address": None, "tax_exempt": "none", "tax_ids": [],
                                                      "business_name": None, "individual_name": None},
        "payment_intent": pi, "subscription": sub, "invoice": None, "payment_link": "plink_1" if sid == "cs_2" else None,
        "client_reference_id": f"cart_{sid[3:]}", "locale": "auto", "expires_at": t(day + 1), "created": t(day),
        "livemode": False, "metadata": {}, "client_secret": f"cs_secret_doNotLeak_{sid}",
        "url": f"https://checkout.stripe.com/c/pay/{sid}" if status == "open" else None,
    })

WEBHOOK_ENDPOINTS = [
    {"id": "we_1", "object": "webhook_endpoint", "url": "https://hooks.example.com/stripe/webhook?token=hunter2",
     "status": "enabled", "enabled_events": ["charge.succeeded", "invoice.paid", "customer.subscription.deleted"],
     "api_version": "2026-09-30.endive", "application": None, "description": "Billing sync", "created": t(-90),
     "livemode": False, "metadata": {}, "secret": "whsec_doNotLeak1"},
    {"id": "we_2", "object": "webhook_endpoint", "url": "https://audit.example.org/in", "status": "disabled",
     "enabled_events": ["*"], "api_version": None, "application": None, "description": None, "created": t(-200),
     "livemode": False, "metadata": {}},
]

FILES = [
    {"id": "file_1", "object": "file", "purpose": "dispute_evidence", "filename": "receipt_ch_5.pdf",
     "title": None, "type": "pdf", "size": 48213, "expires_at": None,
     "url": "https://files.stripe.com/v1/files/file_1/contents", "created": t(10), "links": None},
    {"id": "file_2", "object": "file", "purpose": "finance_report_run", "filename": "balance_summary.csv",
     "title": None, "type": "csv", "size": 1024, "expires_at": t(40),
     "url": "https://files.stripe.com/v1/files/file_2/contents", "created": t(3), "links": None},
    {"id": "file_3", "object": "file", "purpose": "identity_document", "filename": "passport.png",
     "title": None, "type": "png", "size": 512000, "expires_at": None, "url": None, "created": t(-5), "links": None},
]

ACCOUNTS = [
    {"id": "acct_connected1", "object": "account", "type": "express", "business_type": "individual", "country": "US",
     "default_currency": "usd", "email": "seller1@example.com",
     "business_profile": {"name": "Seller One", "url": "https://seller1.example.com", "mcc": "5734"},
     "charges_enabled": True, "payouts_enabled": True, "details_submitted": True,
     "requirements": {"currently_due": [], "disabled_reason": None, "eventually_due": [], "past_due": []},
     "created": t(-100), "metadata": {"tier": "gold"}},
    {"id": "acct_connected2", "object": "account", "type": "custom", "business_type": "company", "country": "GB",
     "default_currency": "gbp", "email": "ops@seller2.example.co.uk",
     "business_profile": {"name": "Seller Two Ltd", "url": None, "mcc": "5999"},
     "charges_enabled": True, "payouts_enabled": False, "details_submitted": False,
     "requirements": {"currently_due": ["external_account", "tos_acceptance.date"],
                      "disabled_reason": "requirements.past_due", "eventually_due": [], "past_due": ["external_account"]},
     "created": t(-30), "metadata": {}},
]

APPLICATION_FEES = [
    {"id": "fee_1", "object": "application_fee", "account": "acct_connected1", "application": "ca_platform",
     "charge": "py_c1", "originating_transaction": "ch_c1", "amount": 200, "amount_refunded": 0, "currency": "usd",
     "refunded": False, "balance_transaction": "txn_fee_1", "created": t(2), "livemode": False},
    {"id": "fee_2", "object": "application_fee", "account": "acct_connected2", "application": "ca_platform",
     "charge": "py_c2", "originating_transaction": "ch_c2", "amount": 150, "amount_refunded": 50, "currency": "gbp",
     "refunded": False, "balance_transaction": "txn_fee_2", "created": t(4), "livemode": False},
]

TRANSFERS = [
    {"id": "tr_1", "object": "transfer", "destination": "acct_connected1", "amount": 1600, "amount_reversed": 0,
     "currency": "usd", "reversed": False, "description": "Order 42 seller share", "source_transaction": "ch_10",
     "destination_payment": "py_t1", "source_type": "card", "transfer_group": "order_42",
     "balance_transaction": "txn_tr_1", "created": t(8.1), "livemode": False, "metadata": {}},
    {"id": "tr_2", "object": "transfer", "destination": "acct_connected2", "amount": 3000, "amount_reversed": 1000,
     "currency": "gbp", "reversed": False, "description": None, "source_transaction": None,
     "destination_payment": "py_t2", "source_type": "card", "transfer_group": None,
     "balance_transaction": "txn_tr_2", "created": t(3), "livemode": False, "metadata": {}},
    {"id": "tr_3", "object": "transfer", "destination": "acct_connected1", "amount": 900, "amount_reversed": 0,
     "currency": "usd", "reversed": False, "description": None, "source_transaction": None,
     "destination_payment": "py_t3", "source_type": "card", "transfer_group": None,
     "balance_transaction": "txn_tr_3", "created": t(9), "livemode": False, "metadata": {}},
]

METERS = [
    {"id": "mtr_api_calls", "object": "billing.meter", "display_name": "API Calls", "event_name": "api_call",
     "status": "active", "default_aggregation": {"formula": "sum"}, "event_time_window": None,
     "customer_mapping": {"event_payload_key": "stripe_customer_id", "type": "by_id"},
     "value_settings": {"event_payload_key": "value"}, "created": t(-45), "updated": t(-45), "livemode": False,
     "status_transitions": {"deactivated_at": None}},
    {"id": "mtr_legacy", "object": "billing.meter", "display_name": "Legacy Storage", "event_name": "storage_gb",
     "status": "inactive", "default_aggregation": {"formula": "last"}, "event_time_window": "day",
     "customer_mapping": {"event_payload_key": "customer", "type": "by_id"},
     "value_settings": {"event_payload_key": "gb"}, "created": t(-400), "updated": t(-100), "livemode": False,
     "status_transitions": {"deactivated_at": t(-100)}},
]
# Hourly usage (the server sums these into minute/hour/day windows).
METER_USAGE = []
for h in range(72):
    METER_USAGE.append({"meter": "mtr_api_calls", "customer": "cus_margaret", "hour": t(0, h), "value": 10 + (h % 5)})
    if h % 3 == 0:
        METER_USAGE.append({"meter": "mtr_api_calls", "customer": "cus_ada", "hour": t(0, h), "value": 2})

EARLY_FRAUD_WARNINGS = [
    {"id": "issfr_1", "object": "radar.early_fraud_warning", "charge": "ch_5", "payment_intent": "pi_5",
     "fraud_type": "made_with_stolen_card", "actionable": True, "created": t(8), "livemode": False},
    {"id": "issfr_2", "object": "radar.early_fraud_warning", "charge": "ch_8", "payment_intent": "pi_8",
     "fraud_type": "unauthorized_use_of_card", "actionable": False, "created": t(7.5), "livemode": False},
]

BALANCE = {
    "object": "balance", "livemode": False,
    "available": [
        {"amount": 12345, "currency": "usd", "source_types": {"card": 12000, "bank_account": 345}},
        {"amount": 6789, "currency": "gbp", "source_types": {"card": 6789}},
        {"amount": 3000, "currency": "jpy", "source_types": {"card": 3000}},
        {"amount": 1500, "currency": "kwd", "source_types": {"card": 1500}},
    ],
    "pending": [{"amount": 2500, "currency": "usd", "source_types": {"card": 2500}},
                {"amount": 4200, "currency": "eur", "source_types": {"card": 4200}}],
    "connect_reserved": [{"amount": 0, "currency": "usd"}],
}


def event(eid, etype, obj, created, previous=None, request=None):
    data = {"object": obj}
    if previous is not None:
        data["previous_attributes"] = previous
    return {"id": eid, "object": "event", "type": etype, "created": created, "data": data,
            "api_version": "2026-09-30.endive", "pending_webhooks": 0 if eid != "evt_inv_2" else 1,
            "request": {"id": request, "idempotency_key": f"idem-{eid}" if request else None},
            "livemode": False}


EVENTS = []
n = 0
for c in CUSTOMERS:
    n += 1
    EVENTS.append(event(f"evt_cus_{n}", "customer.created", c, c["created"], request=f"req_cus_{n}"))
for ch in CHARGES:
    etype = {"succeeded": "charge.succeeded", "failed": "charge.failed", "pending": "charge.pending"}[ch["status"]]
    EVENTS.append(event(f"evt_{ch['id']}", etype, ch, ch["created"]))
for r in REFUNDS:
    EVENTS.append(event(f"evt_{r['id']}", "charge.refunded", next(c for c in CHARGES if c["id"] == r["charge"]),
                        r["created"], previous={"amount_refunded": 0}, request=f"req_{r['id']}"))
for i, inv in enumerate(INVOICES):
    EVENTS.append(event(f"evt_inv_{i + 1}", f"invoice.{ {'paid': 'paid', 'open': 'finalized', 'void': 'voided', 'uncollectible': 'marked_uncollectible', 'draft': 'created'}[inv['status']] }",
                        {k: v for k, v in inv.items() if k != "lines"}, inv["created"] + 3600))
for s in SUBSCRIPTIONS:
    EVENTS.append(event(f"evt_{s['id']}_created", "customer.subscription.created", s, s["created"]))
EVENTS.append(event("evt_sub_alan_deleted", "customer.subscription.deleted",
                    next(s for s in SUBSCRIPTIONS if s["id"] == "sub_alan"), t(-3)))
EVENTS.append(event("evt_sub_margaret_updated", "customer.subscription.updated",
                    next(s for s in SUBSCRIPTIONS if s["id"] == "sub_margaret"), t(1),
                    previous={"cancel_at_period_end": False}, request="req_portal_1"))
for p in PAYOUTS:
    etype = {"paid": "payout.paid", "in_transit": "payout.created", "failed": "payout.failed"}[p["status"]]
    EVENTS.append(event(f"evt_{p['id']}", etype, p, p["created"] + 600))
for d in DISPUTES:
    EVENTS.append(event(f"evt_{d['id']}", "charge.dispute.created", d, d["created"]))


# The connected account acct_connected1, served when Stripe-Account: acct_connected1.
CONNECTED = {
    "acct_connected1": {
        "customers": [{**CUSTOMERS[0], "id": "cus_c1", "email": "buyer@example.net", "name": "Connected Buyer",
                       "metadata": {}, "currency": "usd", "balance": 0}],
        "charges": [{**CHARGES[0], "id": "ch_c1", "customer": "cus_c1", "amount": 4000, "currency": "usd",
                     "payment_intent": "pi_c1", "balance_transaction": "txn_c1", "application_fee_amount": 200,
                     "description": "Connected sale"}],
        "balance": {"object": "balance", "livemode": False,
                    "available": [{"amount": 3800, "currency": "usd", "source_types": {"card": 3800}}],
                    "pending": []},
    }
}

ACCOUNT = {
    "_comment": "Generated by test/fixtures/build_fixture.py; do not edit by hand.",
    "t0": T0,
    "balance": BALANCE,
    "collections": {
        "balance_transactions": BALANCE_TRANSACTIONS, "charges": CHARGES, "payment_intents": PAYMENT_INTENTS,
        "refunds": REFUNDS, "disputes": DISPUTES, "payouts": PAYOUTS, "customers": CUSTOMERS,
        "payment_methods": PAYMENT_METHODS, "invoices": INVOICES, "invoice_lines": INVOICE_LINES,
        "invoiceitems": INVOICE_ITEMS, "subscriptions": SUBSCRIPTIONS, "subscription_items": SUBSCRIPTION_ITEMS,
        "subscription_schedules": SUBSCRIPTION_SCHEDULES, "products": PRODUCTS, "prices": PRICES,
        "coupons": COUPONS, "promotion_codes": PROMOTION_CODES, "credit_notes": CREDIT_NOTES,
        "tax_rates": TAX_RATES, "checkout_sessions": CHECKOUT_SESSIONS, "events": EVENTS,
        "webhook_endpoints": WEBHOOK_ENDPOINTS, "files": FILES, "accounts": ACCOUNTS,
        "application_fees": APPLICATION_FEES, "transfers": TRANSFERS, "billing_meters": METERS,
        "early_fraud_warnings": EARLY_FRAUD_WARNINGS,
    },
    "payout_contents": PAYOUT_CONTENTS,
    "meter_usage": METER_USAGE,
    "connected": CONNECTED,
}

json.dump(ACCOUNT, sys.stdout, indent=1, sort_keys=True)
sys.stdout.write("\n")
