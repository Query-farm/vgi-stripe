#!/usr/bin/env python3
"""A strict offline Stripe API replay server for the tests (stdlib only).

It serves the account in ``test/fixtures/stripe-account.json`` and behaves like Stripe
where the worker depends on it:

* **Shapes from the spec.** At start-up every fixture object's fields are checked
  against Stripe's OpenAPI spec (the trimmed ``stripe-openapi-subset.json``), so the
  fixtures cannot drift from real Stripe objects.
* **Auth.** ``Authorization: Bearer rk_test_fixture`` (restricted, read-only) or
  ``sk_test_fixture``; ``rk_test_nopayouts`` is a restricted key without the payouts
  permission (403). Anything else gets Stripe's 401. ``Stripe-Version`` must look like
  a version; ``Stripe-Account: acct_connected1`` serves that connected account's data,
  any other account is a 403.
* **Strict parameters.** Each endpoint accepts exactly its spec parameters, in their
  spec shapes (``created[gte]``, ``expand[]``, ``types[]``, enums, integer types,
  ``limit`` 1-100, required parameters). A spec parameter this replay server does not
  implement is a 400 too, so a pushdown can never be silently ignored.
* **Filtering.** List parameters really filter (ids, status/type, booleans, every time
  range, ``type=charge.*`` wildcards, ``payout`` contents, subscriptions' default of
  "not canceled" and ``status=all``), so wrong pushdown returns wrong rows.
* **Search.** ``/v1/<resource>/search`` parses Stripe's query language subset
  (``field:"v"``, ``field~"sub"`` with 3+ characters, ``> < >= <=`` on numbers and
  ``created``, ``metadata["k"]:"v"``, ``-`` negation, ``null``; clauses joined by AND or
  by OR but not both, at most 10) against each resource's documented search fields.
* **Paging.** Newest first; ``starting_after`` / ``ending_before`` / ``has_more``; search
  ``page`` / ``next_page`` tokens. Pages hold at most ``--page-cap`` objects (default 3)
  so every scan crosses page boundaries, as Stripe may return fewer than ``limit``.
* **Expansion.** ``expand[]=data.<field>[.<field>…]`` replaces ids with the objects.
* **Rate limits and errors.** The first ``/v1/disputes`` request answers 429 and the
  first ``/v1/payouts`` request 500, both with ``Stripe-Should-Retry: true``; the first
  ``/v1/files`` request answers 503 with ``Stripe-Should-Retry: false`` (must not be
  retried).
* **Introspection.** ``GET /__requests?path=/v1/charges`` returns every recorded request
  to that path (``seq``, ``path``, ``query`` as a JSON object string, ``auth``,
  ``account``, ``version``).

Usage::

    python3 test/mock_api/server.py [--page-cap 3]      # prints PORT:<n> once listening
"""

from __future__ import annotations

import argparse
import base64
import copy
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlparse

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent / "fixtures"
ACCOUNT = json.loads((FIXTURES / "stripe-account.json").read_text())
SPEC = json.loads((FIXTURES / "stripe-openapi-subset.json").read_text())

KEYS = {"rk_test_fixture": set(), "sk_test_fixture": set(), "rk_test_nopayouts": {"/v1/payouts"}}
LOCK = threading.Lock()
REQUESTS: list[dict] = []
ONCE: set[str] = set()
PAGE_CAP = 3

OBJECT_TYPES = {
    "balance_transactions": "balance_transaction", "charges": "charge", "payment_intents": "payment_intent",
    "refunds": "refund", "disputes": "dispute", "payouts": "payout", "customers": "customer",
    "payment_methods": "payment_method", "invoices": "invoice", "invoice_lines": "line_item",
    "invoiceitems": "invoiceitem", "subscriptions": "subscription", "subscription_items": "subscription_item",
    "subscription_schedules": "subscription_schedule", "products": "product", "prices": "price", "coupons": "coupon",
    "promotion_codes": "promotion_code", "credit_notes": "credit_note", "tax_rates": "tax_rate",
    "checkout_sessions": "checkout.session", "events": "event", "webhook_endpoints": "webhook_endpoint",
    "files": "file", "accounts": "account", "application_fees": "application_fee", "transfers": "transfer",
    "billing_meters": "billing.meter", "early_fraud_warnings": "radar.early_fraud_warning",
}


class ApiError(Exception):
    def __init__(self, status: int, etype: str, message: str, param: str | None = None, code: str | None = None):
        super().__init__(message)
        self.status, self.etype, self.message, self.param, self.code = status, etype, message, param, code


def bad(message: str, param: str | None = None, code: str = "parameter_invalid") -> ApiError:
    return ApiError(400, "invalid_request_error", message, param, code)


def validate_fixtures() -> None:
    def check(name: str, objs: list) -> None:
        props = set(SPEC["objects"][OBJECT_TYPES[name]])
        for o in objs:
            extra = set(o) - props
            if extra:
                sys.exit(f"fixture {name}/{o.get('id')}: fields not in the Stripe spec: {sorted(extra)}")

    for name, objs in ACCOUNT["collections"].items():
        check(name, objs)
    for acct in ACCOUNT["connected"].values():
        for name, objs in acct.items():
            if name != "balance":
                check(name, objs)
    extra = set(ACCOUNT["balance"]) - set(SPEC["objects"]["balance"])
    if extra:
        sys.exit(f"fixture balance: fields not in the Stripe spec: {sorted(extra)}")


# ------------------------------------------------------------------ helpers


def id_of(v):
    if isinstance(v, str):
        return v
    if isinstance(v, dict):
        return v.get("id")
    return None


def at(obj, path: str):
    cur = obj
    for p in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(p)
    return cur


def collection(account: str | None, name: str) -> list:
    if account:
        return ACCOUNT["connected"][account].get(name, [])
    return ACCOUNT["collections"].get(name, [])


def all_objects(account: str | None) -> dict:
    out = {}
    src = ACCOUNT["connected"][account] if account else ACCOUNT["collections"]
    for name, objs in src.items():
        if isinstance(objs, list):
            for o in objs:
                if isinstance(o, dict) and "id" in o:
                    out[o["id"]] = o
    return out


def parse_params(pairs: list[tuple[str, str]]) -> dict:
    """Group bracketed form parameters: a=1, a[]=1&a[]=2, a[gte]=1."""
    out: dict = {}
    for k, v in pairs:
        m = re.fullmatch(r"([a-z_]+)(?:\[([a-z_]*)\])?", k)
        if not m:
            raise bad(f"Received unknown parameter: {k}", k, "parameter_unknown")
        name, sub = m.group(1), m.group(2)
        if sub is None:
            if name in out:
                raise bad(f"Parameter {name} given twice", name)
            out[name] = v
        elif sub == "":
            cur = out.setdefault(name, [])
            if not isinstance(cur, list):
                raise bad(f"Invalid array: {name}", name)
            cur.append(v)
        else:
            cur = out.setdefault(name, {})
            if not isinstance(cur, dict):
                raise bad(f"Invalid hash: {name}", name)
            cur[sub] = v
    return out


def to_int(v: str, name: str) -> int:
    if not re.fullmatch(r"-?\d+", v):
        raise bad(f"Invalid integer: {v}", name)
    return int(v)


def to_bool(v: str, name: str) -> bool:
    if v not in ("true", "false"):
        raise bad(f"Invalid boolean: {v}", name)
    return v == "true"


def check_spec(spec_path: str, params: dict, handled: set[str]) -> None:
    allowed = {k: v for k, v in SPEC["paths"][spec_path].items() if v["in"] == "query"}
    for name, val in params.items():
        info = allowed.get(name)
        if not info:
            raise bad(f"Received unknown parameter: {name}", name, "parameter_unknown")
        if name not in handled:
            raise bad(f"replay server: parameter {name} is valid for Stripe but not implemented here", name)
        types = info["types"]
        if isinstance(val, list):
            if "array" not in types:
                raise bad(f"Invalid {name}: must be a scalar", name)
        elif isinstance(val, dict):
            if "object" not in types:
                raise bad(f"Invalid {name}: must be a scalar", name)
            for sub in val:
                if sub not in info.get("keys", []):
                    raise bad(f"Received unknown parameter: {name}[{sub}]", f"{name}[{sub}]", "parameter_unknown")
        else:
            if types == ["object"] or types == ["array"]:
                raise bad(f"Invalid {name}: must be {'a hash' if types == ['object'] else 'an array'}", name)
            if "integer" in types:
                to_int(val, name)
            if "boolean" in types:
                to_bool(val, name)
            if info.get("enum") and val not in info["enum"]:
                raise bad(f"Invalid {name}: must be one of {', '.join(info['enum'])}", name)
    for name, info in allowed.items():
        if info["required"] and name not in params:
            raise bad(f"Missing required param: {name}.", name, "parameter_missing")
    if "limit" in params:
        n = to_int(params["limit"], "limit")
        if n < 1 or n > 100:
            raise bad("Invalid limit: must be between 1 and 100", "limit")


def range_match(value, spec, name: str) -> bool:
    if value is None:
        return False
    if isinstance(spec, str):
        return value == to_int(spec, name)
    ops = {"gt": lambda a, b: a > b, "gte": lambda a, b: a >= b, "lt": lambda a, b: a < b, "lte": lambda a, b: a <= b}
    return all(ops[k](value, to_int(v, f"{name}[{k}]")) for k, v in spec.items())


def expand_obj(obj, path: list[str], index: dict, depth: int = 0):
    if not path or not isinstance(obj, dict):
        return obj
    head, rest = path[0], path[1:]
    if head not in obj:
        raise bad(f"This property cannot be expanded ({head}).", "expand")
    val = obj[head]
    if isinstance(val, str):
        target = index.get(val)
        if target is None:
            raise bad(f"This property cannot be expanded ({head}): no such object {val}.", "expand")
        val = copy.deepcopy(target)
    if isinstance(val, dict):
        obj[head] = expand_obj(val, rest, index, depth + 1)
    return obj


def apply_expand(objs: list, params: dict, index: dict, prefix: str = "data.") -> list:
    paths = params.get("expand", [])
    out = [copy.deepcopy(o) for o in objs]
    for p in paths:
        if not p.startswith(prefix):
            raise bad(f"This property cannot be expanded ({p}).", "expand")
        segs = p[len(prefix):].split(".")
        if len(segs) > 3:
            raise bad("You cannot expand more than 4 levels of a property.", "expand")
        out = [expand_obj(o, segs, index) for o in out]
    return out


def newest_first(objs: list) -> list:
    return sorted(objs, key=lambda o: (-(o.get("created") or o.get("date") or 0), o.get("id", "")))


def paginate(objs: list, params: dict, url: str) -> dict:
    limit = min(int(params.get("limit", "10")), PAGE_CAP)
    ids = [o["id"] for o in objs]
    if "starting_after" in params and "ending_before" in params:
        raise bad("You may only specify one of these parameters: ending_before, starting_after.")
    start = 0
    if "starting_after" in params:
        sa = params["starting_after"]
        if sa not in ids:
            raise bad(f"No such object: '{sa}'", "starting_after", "resource_missing")
        start = ids.index(sa) + 1
        page = objs[start:start + limit]
        more = start + limit < len(objs)
    elif "ending_before" in params:
        eb = params["ending_before"]
        if eb not in ids:
            raise bad(f"No such object: '{eb}'", "ending_before", "resource_missing")
        end = ids.index(eb)
        page = objs[max(0, end - limit):end]
        more = end - limit > 0
    else:
        page = objs[:limit]
        more = limit < len(objs)
    return {"object": "list", "data": page, "has_more": more, "url": url}


# ------------------------------------------------------------------ list routes

TIME_PARAMS = {"created", "arrival_date", "due_date", "canceled_at", "completed_at", "released_at",
               "current_period_start", "current_period_end"}


def field_filter(field: str, kind: str = "id"):
    def f(o, v):
        if kind == "bool":
            return o.get(field) is to_bool(v, field)
        return id_of(at(o, field)) == v
    return f


# path → (collection, {param: predicate(obj, value)})
LIST_ROUTES = {
    "/v1/balance_transactions": ("balance_transactions", {
        "type": field_filter("type"), "source": field_filter("source"), "currency": field_filter("currency"),
        "payout": lambda o, v: o["id"] in ACCOUNT["payout_contents"].get(v, [])}),
    "/v1/charges": ("charges", {"customer": field_filter("customer"), "payment_intent": field_filter("payment_intent"),
                                 "transfer_group": field_filter("transfer_group")}),
    "/v1/payment_intents": ("payment_intents", {"customer": field_filter("customer")}),
    "/v1/refunds": ("refunds", {"charge": field_filter("charge"), "payment_intent": field_filter("payment_intent")}),
    "/v1/disputes": ("disputes", {"charge": field_filter("charge"), "payment_intent": field_filter("payment_intent")}),
    "/v1/payouts": ("payouts", {"status": field_filter("status"), "destination": field_filter("destination")}),
    "/v1/customers": ("customers", {"email": field_filter("email"), "test_clock": field_filter("test_clock")}),
    "/v1/invoices": ("invoices", {
        "customer": field_filter("customer"), "status": field_filter("status"),
        "collection_method": field_filter("collection_method"),
        "subscription": lambda o, v: id_of(at(o, "parent.subscription_details.subscription")) == v}),
    "/v1/invoiceitems": ("invoiceitems", {
        "customer": field_filter("customer"), "invoice": field_filter("invoice"),
        "pending": lambda o, v: (o.get("invoice") is None) is to_bool(v, "pending")}),
    "/v1/subscriptions": ("subscriptions", {
        "customer": field_filter("customer"), "collection_method": field_filter("collection_method"),
        "test_clock": field_filter("test_clock"),
        "status": lambda o, v: v == "all" or o["status"] == v
        or (v == "ended" and o["status"] in ("canceled", "incomplete_expired"))}),
    "/v1/subscription_items": ("subscription_items", {"subscription": field_filter("subscription")}),
    "/v1/subscription_schedules": ("subscription_schedules", {"customer": field_filter("customer")}),
    "/v1/products": ("products", {
        "active": field_filter("active", "bool"), "shippable": field_filter("shippable", "bool"),
        "url": field_filter("url"), "ids": lambda o, v: o["id"] in v}),
    "/v1/prices": ("prices", {
        "active": field_filter("active", "bool"), "currency": field_filter("currency"),
        "product": field_filter("product"), "type": field_filter("type"),
        "lookup_keys": lambda o, v: o.get("lookup_key") in v,
        "recurring": lambda o, v: all(at(o, f"recurring.{k}") == x for k, x in v.items())}),
    "/v1/coupons": ("coupons", {}),
    "/v1/promotion_codes": ("promotion_codes", {
        "active": field_filter("active", "bool"), "code": field_filter("code"),
        "coupon": lambda o, v: id_of(at(o, "promotion.coupon")) == v, "customer": field_filter("customer")}),
    "/v1/credit_notes": ("credit_notes", {"customer": field_filter("customer"), "invoice": field_filter("invoice")}),
    "/v1/tax_rates": ("tax_rates", {"active": field_filter("active", "bool"),
                                     "inclusive": field_filter("inclusive", "bool")}),
    "/v1/checkout/sessions": ("checkout_sessions", {
        "customer": field_filter("customer"), "status": field_filter("status"),
        "payment_intent": field_filter("payment_intent"), "payment_link": field_filter("payment_link"),
        "subscription": field_filter("subscription"),
        "customer_details": lambda o, v: all(at(o, f"customer_details.{k}") == x for k, x in v.items())}),
    "/v1/events": ("events", {
        "type": lambda o, v: o["type"].startswith(v[:-1]) if v.endswith("*") else o["type"] == v,
        "types": lambda o, v: o["type"] in v}),
    "/v1/webhook_endpoints": ("webhook_endpoints", {}),
    "/v1/files": ("files", {"purpose": field_filter("purpose")}),
    "/v1/accounts": ("accounts", {}),
    "/v1/application_fees": ("application_fees", {"charge": field_filter("charge")}),
    "/v1/transfers": ("transfers", {"destination": field_filter("destination"),
                                     "transfer_group": field_filter("transfer_group")}),
    "/v1/billing/meters": ("billing_meters", {"status": field_filter("status")}),
    "/v1/radar/early_fraud_warnings": ("early_fraud_warnings", {
        "charge": field_filter("charge"), "payment_intent": field_filter("payment_intent")}),
}
PAGING = {"limit", "starting_after", "ending_before", "expand"}


def time_value(name: str, coll: str, o: dict):
    if coll == "invoiceitems" and name == "created":
        return o.get("date")
    if coll == "subscriptions" and name.startswith("current_period"):
        items = (o.get("items") or {}).get("data") or []
        return items[0].get(name) if items else None
    return o.get(name)


def list_route(path: str, params: dict, account: str | None) -> dict:
    coll, preds = LIST_ROUTES[path]
    times = {p for p in SPEC["paths"][path] if p in TIME_PARAMS}
    check_spec(path, params, set(preds) | PAGING | times)
    objs = newest_first(collection(account, coll))
    if path == "/v1/subscriptions" and "status" not in params:
        objs = [o for o in objs if o["status"] not in ("canceled", "incomplete_expired")]
    for name, val in params.items():
        if name in preds:
            objs = [o for o in objs if preds[name](o, val)]
        elif name in times:
            objs = [o for o in objs if range_match(time_value(name, coll, o), val, name)]
    objs = apply_expand(objs, params, all_objects(account))
    return paginate(objs, params, path)


# ------------------------------------------------------------------ search

SEARCH_FIELDS = {
    "charges": {"amount": "number", "billing_details.address.postal_code": "string", "created": "number",
                "currency": "string", "customer": "string", "disputed": "bool", "metadata": "meta",
                "payment_method_details.card.last4": "string", "refunded": "bool", "status": "string"},
    "customers": {"created": "number", "email": "string", "metadata": "meta", "name": "string", "phone": "string"},
    "invoices": {"created": "number", "currency": "string", "customer": "string", "metadata": "meta",
                 "number": "string", "receipt_number": "string", "status": "string", "subscription": "string",
                 "total": "number"},
    "payment_intents": {"amount": "number", "created": "number", "currency": "string", "customer": "string",
                        "metadata": "meta", "status": "string"},
    "prices": {"active": "bool", "currency": "string", "lookup_key": "string", "metadata": "meta",
               "product": "string", "type": "string"},
    "products": {"active": "bool", "created": "number", "description": "string", "metadata": "meta",
                 "name": "string", "shippable": "bool", "url": "string"},
    "subscriptions": {"created": "number", "metadata": "meta", "status": "string"},
}
CLAUSE = re.compile(
    r'(?P<neg>-)?(?P<field>metadata\["(?P<mkey>(?:[^"\\]|\\.)*)"\]|[a-z_][a-z_.0-9]*)'
    r'(?P<op>:|~|>=|<=|>|<)(?P<value>"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|null)'
)


def unquote(v: str) -> str:
    return re.sub(r"\\(.)", r"\1", v[1:-1])


def parse_search(query: str, resource: str):
    fields = SEARCH_FIELDS[resource]
    q = query.strip()
    if not q:
        raise bad("Search query is empty.", "query")
    has_and, has_or = " AND " in q, " OR " in q
    if has_and and has_or:
        raise bad("Search query cannot mix AND and OR.", "query")
    parts = q.split(" OR " if has_or else " AND ")
    if len(parts) > 10:
        raise bad("Search queries can have at most 10 clauses.", "query")
    clauses = []
    for part in parts:
        m = CLAUSE.fullmatch(part.strip())
        if not m:
            raise bad(f"Could not parse search clause: {part}", "query")
        field = m.group("field")
        kind = "meta" if m.group("mkey") is not None else fields.get(field)
        if kind is None:
            raise bad(f"Field '{field}' is not supported for {resource} search.", "query")
        if kind == "meta" and m.group("mkey") is None:
            raise bad("metadata needs a key: metadata[\"key\"]", "query")
        op, raw = m.group("op"), m.group("value")
        value = None if raw == "null" else unquote(raw) if raw.startswith('"') else float(raw)
        if op in (">", "<", ">=", "<=") and kind != "number":
            raise bad(f"Range operators need a numeric field ({field}).", "query")
        if kind == "number" and op != "~" and isinstance(value, str):
            raise bad(f"Field {field} is numeric.", "query")
        if op == "~":
            if kind not in ("string", "meta") or not isinstance(value, str) or len(value) < 3:
                raise bad("Substring (~) matches need a string of 3+ characters.", "query")
        clauses.append((bool(m.group("neg")), field, m.group("mkey"), kind, op, value))
    return has_or, clauses


def clause_match(o: dict, clause) -> bool:
    neg, field, mkey, kind, op, value = clause
    actual = (o.get("metadata") or {}).get(unquote(f'"{mkey}"')) if kind == "meta" else id_of(at(o, field)) \
        if kind == "string" else at(o, field)
    if value is None:
        r = actual is None
    elif op == "~":
        r = isinstance(actual, str) and value.lower() in actual.lower()
    elif kind == "number":
        if actual is None:
            r = False
        else:
            r = {":": actual == value, ">": actual > value, "<": actual < value, ">=": actual >= value,
                 "<=": actual <= value}[op]
    elif kind == "bool":
        r = isinstance(actual, bool) and str(actual).lower() == str(value).lower()
    else:
        r = isinstance(actual, str) and actual.lower() == str(value).lower()
    return not r if neg else r


def search_route(path: str, params: dict, account: str | None) -> dict:
    resource = path.split("/")[2]
    check_spec(path, params, {"query", "limit", "page", "expand"})
    has_or, clauses = parse_search(params["query"], resource)
    objs = newest_first(collection(account, resource))
    if has_or:
        objs = [o for o in objs if any(clause_match(o, c) for c in clauses)]
    else:
        objs = [o for o in objs if all(clause_match(o, c) for c in clauses)]
    objs = apply_expand(objs, params, all_objects(account))
    limit = min(int(params.get("limit", "10")), PAGE_CAP)
    start = 0
    if "page" in params:
        try:
            tok = json.loads(base64.urlsafe_b64decode(params["page"].encode()).decode())
            start, q = int(tok["offset"]), tok["query"]
        except Exception as exc:
            raise bad("Invalid page token.", "page") from exc
        if q != params["query"]:
            raise bad("The page token does not belong to this query.", "page")
    page = objs[start:start + limit]
    more = start + limit < len(objs)
    nxt = base64.urlsafe_b64encode(json.dumps({"offset": start + limit, "query": params["query"]}).encode()).decode() \
        if more else None
    return {"object": "search_result", "data": page, "has_more": more, "next_page": nxt, "url": path,
            "total_count": len(objs)}


# ------------------------------------------------------------------ other routes


def balance_route(params: dict, account: str | None) -> dict:
    check_spec("/v1/balance", params, set())
    return ACCOUNT["connected"][account]["balance"] if account else ACCOUNT["balance"]


def customer_pms(customer: str, params: dict, account: str | None) -> dict:
    spec = "/v1/customers/{customer}/payment_methods"
    check_spec(spec, params, {"type"} | PAGING)
    if not any(c["id"] == customer for c in collection(account, "customers")):
        raise ApiError(404, "invalid_request_error", f"No such customer: '{customer}'", "customer", "resource_missing")
    objs = [p for p in newest_first(collection(account, "payment_methods")) if p["customer"] == customer]
    if "type" in params:
        objs = [p for p in objs if p["type"] == params["type"]]
    objs = apply_expand(objs, params, all_objects(account))
    return paginate(objs, params, f"/v1/customers/{customer}/payment_methods")


def invoice_lines(invoice: str, params: dict, account: str | None) -> dict:
    check_spec("/v1/invoices/{invoice}/lines", params, PAGING)
    if not any(i["id"] == invoice for i in collection(account, "invoices")):
        raise ApiError(404, "invalid_request_error", f"No such invoice: '{invoice}'", "invoice", "resource_missing")
    objs = [ln for ln in collection(account, "invoice_lines") if ln["invoice"] == invoice]
    objs = apply_expand(objs, params, all_objects(account))
    return paginate(objs, params, f"/v1/invoices/{invoice}/lines")


def meter_summaries(meter: str, params: dict, account: str | None) -> dict:
    check_spec("/v1/billing/meters/{id}/event_summaries", params,
               {"customer", "start_time", "end_time", "value_grouping_window"} | PAGING)
    if not any(m["id"] == meter for m in collection(account, "billing_meters")):
        raise ApiError(404, "invalid_request_error", f"No such billing meter: '{meter}'", "id", "resource_missing")
    start, end = to_int(params["start_time"], "start_time"), to_int(params["end_time"], "end_time")
    window = params.get("value_grouping_window")
    step = {"hour": 3600, "day": 86400}.get(window or "", 60)
    if start % step or end % step:
        raise bad(f"start_time and end_time must be aligned to {window or 'minute'} boundaries.", "start_time")
    if start >= end:
        raise bad("start_time must be before end_time.", "start_time")
    usage = [u for u in ACCOUNT["meter_usage"] if u["meter"] == meter and u["customer"] == params["customer"]]
    buckets = [(s, min(s + step, end)) for s in range(start, end, step)] if window else [(start, end)]
    rows = []
    for s, e in buckets:
        total = sum(u["value"] for u in usage if s <= u["hour"] < e)
        rows.append({"id": f"mtrusg_{meter}_{params['customer']}_{s}", "object": "billing.meter_event_summary",
                     "meter": meter, "start_time": s, "end_time": e, "aggregated_value": float(total),
                     "livemode": False})
    return paginate(rows, params, f"/v1/billing/meters/{meter}/event_summaries")


FAULTS = {
    "/v1/disputes": (429, "true", {"type": "invalid_request_error", "code": "rate_limit",
                                   "message": "Too many requests hit the API too quickly."}),
    "/v1/payouts": (500, "true", {"type": "api_error", "message": "An unknown error occurred."}),
    "/v1/files": (503, "false", {"type": "api_error", "message": "Service unavailable (do not retry this one)."}),
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet
        pass

    def send_json(self, status: int, body, headers: dict | None = None) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Request-Id", f"req_mock_{len(REQUESTS)}")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        if url.path == "/__requests":
            want = dict(parse_qsl(url.query)).get("path")
            with LOCK:
                rows = [r for r in REQUESTS if want is None or r["path"] == want]
            self.send_json(200, rows)
            return
        try:
            pairs = parse_qsl(url.query, keep_blank_values=True)
            raw: dict = {}
            for k, v in pairs:
                raw.setdefault(k, []).append(v)
            auth = self.headers.get("Authorization", "")
            key = auth[7:] if auth.startswith("Bearer ") else ""
            account = self.headers.get("Stripe-Account")
            version = self.headers.get("Stripe-Version")
            with LOCK:
                REQUESTS.append({"seq": len(REQUESTS) + 1, "path": url.path,
                                 "query": json.dumps({k: v[0] if len(v) == 1 else v for k, v in raw.items()},
                                                     sort_keys=True),
                                 "auth": key[:8], "account": account, "version": version})
            if key not in KEYS:
                masked = (key[:8] + "*" * 4) if key else ""
                raise ApiError(401, "invalid_request_error", f"Invalid API Key provided: {masked}")
            if version is not None and not re.fullmatch(r"\d{4}-\d{2}-\d{2}(\.[a-z]+)?", version):
                raise bad(f"Invalid Stripe API version: {version}", None, "api_version_invalid")
            if account is not None and account not in ACCOUNT["connected"]:
                raise ApiError(403, "permission_error",
                               f"The provided key does not have access to account '{account}' (or that account does not exist).")
            if url.path in KEYS[key]:
                raise ApiError(403, "permission_error",
                               f"The provided key '{key[:8]}****' does not have the required permissions for this endpoint.")
            fault = FAULTS.get(url.path)
            if fault and url.path not in ONCE:
                with LOCK:
                    ONCE.add(url.path)
                status, retry, err = fault
                self.send_json(status, {"error": err}, {"Stripe-Should-Retry": retry})
                return
            params = parse_params(pairs)
            self.send_json(200, self.route(url.path, params, account))
        except ApiError as e:
            err = {"type": e.etype, "message": e.message}
            if e.param:
                err["param"] = e.param
            if e.code:
                err["code"] = e.code
            self.send_json(e.status, {"error": err})

    def route(self, path: str, params: dict, account: str | None):
        if path == "/v1/balance":
            return balance_route(params, account)
        if path in LIST_ROUTES:
            return list_route(path, params, account)
        if path.endswith("/search") and path[:-7] in LIST_ROUTES and path in SPEC["paths"]:
            return search_route(path, params, account)
        m = re.fullmatch(r"/v1/customers/([^/]+)/payment_methods", path)
        if m:
            return customer_pms(m.group(1), params, account)
        m = re.fullmatch(r"/v1/invoices/([^/]+)/lines", path)
        if m:
            return invoice_lines(m.group(1), params, account)
        m = re.fullmatch(r"/v1/billing/meters/([^/]+)/event_summaries", path)
        if m:
            return meter_summaries(m.group(1), params, account)
        raise ApiError(404, "invalid_request_error", f"Unrecognized request URL (GET: {path}).")


def main() -> None:
    global PAGE_CAP
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--page-cap", type=int, default=3)
    args = ap.parse_args()
    PAGE_CAP = args.page_cap
    validate_fixtures()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"PORT:{srv.server_address[1]}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
