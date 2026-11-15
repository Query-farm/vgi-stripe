#!/usr/bin/env python3
"""Build the replay server's data for the spec-driven (generated) functions (stdlib, deterministic).

    python3 test/fixtures/build_api_fixture.py > test/fixtures/stripe-api-account.json

For every endpoint in ``src/stripe/generated/endpoints.json`` whose data the curated account
(``stripe-account.json``) does not already hold, it derives objects from Stripe's own example
object for that type (``spec/stripe-openapi/fixtures3.json``, MIT), keeping only fields the
OpenAPI spec defines:

* lists get 4 objects (pages hold 3, so every scan pages) with distinct ids, descending
  ``created``, enum fields cycled through their documented values and
  ``metadata = {"vgi_fixture": "gen", "n": "<i>"}``;
* nested lists get 2 children for each of their first 2 parents (parents come from the
  curated account where it has them, e.g. real customer ids, otherwise from the generated
  parent list); the child's own parent field (e.g. a tax id's ``customer``) is set to match;
* retrieve-only endpoints (mandates, tokens, tax calculations, …) get 2 objects reachable by id;
* sub-objects (a customer's discount / cash balance, a charge's dispute, a financial account's
  features) exist for the first parent only, so the second parent is a 404 the worker skips;
* singletons (/v1/account, /v1/tax/settings, …) get Stripe's example object.

Every credential field (client_secret, secret, apps secret payload, …) is set to a value
containing ``SECRET_LEAK_SENTINEL`` so the SQL tests can prove none of them is ever returned.
"""

from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = json.loads((ROOT / "spec/stripe-openapi/spec3.json").read_text(encoding="utf-8"))
EXAMPLES = json.loads((ROOT / "spec/stripe-openapi/fixtures3.json").read_text(encoding="utf-8"))["resources"]
GEN = json.loads((ROOT / "src/stripe/generated/endpoints.json").read_text(encoding="utf-8"))
CURATED = json.loads((ROOT / "test/fixtures/stripe-account.json").read_text(encoding="utf-8"))
SCHEMAS = SPEC["components"]["schemas"]

T0 = 1793491200  # 2026-11-01T00:00:00Z
DAY = 86400
SENTINEL = "SECRET_LEAK_SENTINEL"
SECRET_FIELDS = {"client_secret", "secret", "password", "private_key_file", "private_key_file_password",
                 "bank_account_token", "client_token", "account_number", "id_number", "payload"}

# Curated paths the replay server already serves from stripe-account.json (path → collection).
CURATED_LISTS = {
    "/v1/balance_transactions": "balance_transactions", "/v1/charges": "charges",
    "/v1/payment_intents": "payment_intents", "/v1/refunds": "refunds", "/v1/disputes": "disputes",
    "/v1/payouts": "payouts", "/v1/customers": "customers", "/v1/invoices": "invoices",
    "/v1/invoiceitems": "invoiceitems", "/v1/subscriptions": "subscriptions",
    "/v1/subscription_items": "subscription_items", "/v1/subscription_schedules": "subscription_schedules",
    "/v1/products": "products", "/v1/prices": "prices", "/v1/coupons": "coupons",
    "/v1/promotion_codes": "promotion_codes", "/v1/credit_notes": "credit_notes", "/v1/tax_rates": "tax_rates",
    "/v1/checkout/sessions": "checkout_sessions", "/v1/events": "events",
    "/v1/webhook_endpoints": "webhook_endpoints", "/v1/files": "files", "/v1/accounts": "accounts",
    "/v1/application_fees": "application_fees", "/v1/transfers": "transfers",
    "/v1/billing/meters": "billing_meters", "/v1/radar/early_fraud_warnings": "early_fraud_warnings",
    "/v1/customers/{customer}/payment_methods": "payment_methods", "/v1/invoices/{invoice}/lines": "invoice_lines",
}


def schema_of(obj_type: str) -> dict:
    s = SCHEMAS[obj_type]
    while "$ref" in s:
        s = SCHEMAS[s["$ref"].split("/")[-1]]
    return s


def deref(x: dict) -> dict:
    while isinstance(x, dict) and "$ref" in x:
        x = SCHEMAS[x["$ref"].split("/")[-1]]
    return x


def trim(obj: dict, obj_type: str) -> dict:
    """Keep only spec-defined top-level fields; add missing ones as null."""
    props = schema_of(obj_type).get("properties", {})
    out = {k: v for k, v in obj.items() if k in props}
    for k in props:
        out.setdefault(k, None)
    return out


def plant_secrets(v, path: str = ""):
    if isinstance(v, dict):
        return {k: (f"{SENTINEL}_{k}" if k in SECRET_FIELDS and k != "payload" else plant_secrets(x, f"{path}.{k}"))
                for k, x in v.items()}
    if isinstance(v, list):
        return [plant_secrets(x, path) for x in v]
    return v


def id_prefix(example_id: str) -> str:
    m = re.match(r"^([a-z]+(?:_[a-z]+)?)_[A-Za-z0-9]+$", example_id or "")
    return m.group(1) if m else ""


def make_id(obj_type: str, example_id: str | None, tag: str, i: int) -> str:
    pre = id_prefix(example_id or "")
    if pre:
        return f"{pre}_gen{tag}{i}"
    return f"{example_id or obj_type.replace('.', '_')}_gen{tag}{i}"


def vary(obj: dict, obj_type: str, i: int, tag: str) -> dict:
    o = copy.deepcopy(obj)
    props = schema_of(obj_type).get("properties", {})
    if "id" in props:
        o["id"] = make_id(obj_type, obj.get("id"), tag, i)
    for k, p in props.items():
        d = deref(p)
        if d.get("type") == "string" and d.get("enum") and k not in ("object", "currency") and o.get(k) is not None:
            enum = d["enum"]
            o[k] = enum[i % len(enum)]
        if d.get("format") == "unix-time" and k != "created" and isinstance(o.get(k), int):
            o[k] = T0 - (i + 1) * DAY // 2
    if "created" in props:
        o["created"] = T0 - (i + 1) * DAY
    if "metadata" in props:
        o["metadata"] = {"vgi_fixture": "gen", "n": str(i)}
    if "livemode" in props:
        o["livemode"] = False
    if obj_type == "apps.secret":
        o["payload"] = f"{SENTINEL}_payload"
        o["name"] = f"vgi-secret-{i}"
    return plant_secrets(o)


def example(obj_type: str) -> dict:
    if obj_type in EXAMPLES:
        return trim(EXAMPLES[obj_type], obj_type)
    return trim({"object": obj_type}, obj_type)


def item_type(ep: dict) -> str:
    return ep["object"].split(" / ")[0]


def tag_of(ep: dict) -> str:
    return re.sub(r"[^a-z0-9]", "", (ep["schema"][:3] + ep["name"]).lower())[:10]


def main() -> None:
    lists: dict[str, list] = {}  # path → [{"parent": id|None, "obj": {...}}]
    objects: dict[str, list] = {}  # retrieve-only path → [obj]
    subs: dict[str, dict] = {}  # sub path → {parent id: obj}
    singles: dict[str, dict] = {}
    endpoints = sorted(GEN["endpoints"], key=lambda e: (e["fanout"] is not None, e["path"]))

    def parent_ids(path: str | None) -> list[str]:
        if path is None:
            return []
        if path in CURATED_LISTS:
            return [o["id"] for o in CURATED["collections"][CURATED_LISTS[path]]][:2]
        return [x["obj"]["id"] for x in lists.get(path, [])][:2]

    # Pass 1: top-level lists, retrieve-only, singletons. Pass 2: nested lists and subs.
    for pass_ in (1, 2):
        for ep in endpoints:
            path, mode, fan = ep["path"], ep["mode"], ep["fanout"]
            nested = fan is not None and fan.get("parent") is not None
            needs_retrieve_parent = fan is not None and fan.get("parent") is None and mode == "list"
            if (pass_ == 1) == (nested or needs_retrieve_parent):
                continue
            if path in CURATED_LISTS or path == "/v1/balance" or path.endswith("/event_summaries"):
                continue
            t = item_type(ep)
            base = example(t)
            tag = tag_of(ep)
            if mode == "single":
                singles[path] = plant_secrets(trim(EXAMPLES.get(t, {"object": t}), t))
            elif mode == "retrieve":
                objects[path] = [vary(base, t, i, tag) for i in range(2)]
            elif mode == "sub":
                pids = parent_ids(fan["parent"])
                if pids:
                    o = vary(base, t, 0, tag)
                    if fan["key"] in o:
                        o[fan["key"]] = pids[0]
                    subs[path] = {pids[0]: o}
            elif fan is None:
                lists[path] = [{"parent": None, "obj": vary(base, t, i, tag)} for i in range(4)]
            else:
                if fan.get("parent") is None:  # parents are retrieve-only objects (tax calculations, sources)
                    retrieve_path = re.sub(r"/[a-z_]+$", "", fan["child"]) if "pathParam" in fan else None
                    pids = [o["id"] for o in objects.get(retrieve_path or "", [])][:2]
                    if not pids:
                        pids = [f"{fan['key']}_gen{i}" for i in range(2)]
                else:
                    pids = parent_ids(fan["parent"])
                rows = []
                for pi, pid in enumerate(pids):
                    for j in range(2):
                        o = vary(base, t, pi * 2 + j, tag)
                        key = fan.get("queryParam") or fan["key"]
                        if key in o:
                            o[key] = pid
                        rows.append({"parent": pid, "obj": o})
                lists[path] = rows
    # Financial Connections owners are listed per (account, ownership): match the parent's ownership id.
    fca = {x["obj"]["id"]: x["obj"] for x in lists.get("/v1/financial_connections/accounts", [])}
    for i, acct in enumerate(fca.values()):
        acct["ownership"] = f"fcaowns_gen{i}"
    for row in lists.get("/v1/financial_connections/accounts/{account}/owners", []):
        row["obj"]["ownership"] = fca[row["parent"]]["ownership"]
    out = {
        "_comment": "Generated by test/fixtures/build_api_fixture.py from spec/stripe-openapi/fixtures3.json. Do not edit.",
        "lists": lists, "objects": objects, "subs": subs, "singles": singles,
    }
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")  # redirected stdout is the locale codepage on Windows
    json.dump(out, sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
