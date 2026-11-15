#!/usr/bin/env python3
"""Trim Stripe's OpenAPI spec (github.com/stripe/openapi, MIT) to what the replay server needs.

    curl -fsSLO https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
    python3 test/fixtures/build_spec_subset.py spec3.json > test/fixtures/stripe-openapi-subset.json

The subset keeps, for every GET endpoint the worker calls, its query parameters (type,
enum, the sub-keys of object parameters such as ``created[gte]``, required flags) and,
for every object type the fixtures contain, its property names. The replay server
rejects unknown parameters with it and checks every fixture object's fields against it.
"""

from __future__ import annotations

import json
import sys

PATHS = [
    "/v1/balance", "/v1/balance_transactions", "/v1/charges", "/v1/charges/search", "/v1/payment_intents",
    "/v1/payment_intents/search", "/v1/refunds", "/v1/disputes", "/v1/payouts", "/v1/customers",
    "/v1/customers/search", "/v1/customers/{customer}/payment_methods", "/v1/invoices", "/v1/invoices/search",
    "/v1/invoices/{invoice}/lines", "/v1/invoiceitems", "/v1/subscriptions", "/v1/subscriptions/search",
    "/v1/subscription_items", "/v1/subscription_schedules", "/v1/products", "/v1/products/search", "/v1/prices",
    "/v1/prices/search", "/v1/coupons", "/v1/promotion_codes", "/v1/credit_notes", "/v1/tax_rates",
    "/v1/checkout/sessions", "/v1/events", "/v1/webhook_endpoints", "/v1/files", "/v1/accounts",
    "/v1/application_fees", "/v1/transfers", "/v1/billing/meters", "/v1/billing/meters/{id}/event_summaries",
    "/v1/radar/early_fraud_warnings",
]
OBJECTS = [
    "balance", "balance_transaction", "charge", "payment_intent", "refund", "dispute", "payout", "customer",
    "payment_method", "invoice", "line_item", "invoiceitem", "subscription", "subscription_item",
    "subscription_schedule", "product", "price", "coupon", "promotion_code", "credit_note", "tax_rate",
    "checkout.session", "event", "webhook_endpoint", "file", "account", "application_fee", "transfer",
    "billing.meter", "billing.meter_event_summary", "radar.early_fraud_warning",
]


def param_info(spec: dict, p: dict) -> dict:
    s = p.get("schema", {})
    info: dict = {"in": p["in"], "required": bool(p.get("required"))}
    variants = s.get("anyOf", [s])
    types = []
    for v in variants:
        if "$ref" in v:
            v = spec["components"]["schemas"][v["$ref"].split("/")[-1]]
        t = v.get("type")
        types.append(t)
        if t == "object" and v.get("properties"):
            info["keys"] = sorted(v["properties"])
        if v.get("enum"):
            info["enum"] = v["enum"]
    info["types"] = sorted({t for t in types if t})
    return info


def main() -> None:
    spec = json.load(open(sys.argv[1]))
    out = {"source": "https://github.com/stripe/openapi (MIT)", "api_version": spec["info"]["version"],
           "paths": {}, "objects": {}}
    for path in PATHS:
        op = spec["paths"][path]["get"]
        out["paths"][path] = {p["name"]: param_info(spec, p) for p in op.get("parameters", [])}
    for name in OBJECTS:
        out["objects"][name] = sorted(spec["components"]["schemas"][name]["properties"])
    json.dump(out, sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
