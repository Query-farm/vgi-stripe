/**
 * Stripe REST API client: authentication, retries and form-style query encoding.
 *
 * - **Auth.** A `stripe` DuckDB secret carries the API key (a restricted key with
 *   read scopes is recommended; a full secret key also works), an optional
 *   `stripe_account` for Connect (`Stripe-Account` header), an optional API version
 *   pin (`Stripe-Version`) and an optional `base_url` (fixtures / proxies). The key is
 *   read on every call and never enters table-function state.
 * - **Retries.** 429 (rate limited), 409 lock timeouts, 5xx and network errors are
 *   retried with exponential backoff and jitter. `Stripe-Should-Retry: false` stops a
 *   retry, `true` forces one; `Retry-After` is honoured when Stripe sends it.
 * - **Query encoding.** Stripe takes nested params in bracket form:
 *   `created[gte]=…`, `expand[]=data.customer`, `types[]=charge.succeeded`.
 */

import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { STRIPE_API_VERSION, VERSION } from "../meta.ts";

export const SECRET_TYPE = "stripe";
export const DEFAULT_BASE_URL = "https://api.stripe.com";
export const TIMEOUT_MS = 60_000;
export const MAX_ATTEMPTS = 6;
/** Longest single backoff wait. */
export const MAX_WAIT_MS = 30_000;
const USER_AGENT = `vgi-stripe-worker/${VERSION}`;

export class StripeError extends Error {
  constructor(
    message: string,
    /** HTTP status of a failed request (0 = not an HTTP failure). */
    readonly status = 0,
    /** Stripe's `error.code` (e.g. `resource_missing`), when given. */
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * Stripe's answers when a product is not enabled on the account (Issuing, Treasury, Connect,
 * Climate, Identity, Tax …) or the key lacks the permission. Matched on the message, since
 * Stripe uses several codes and statuses for it.
 */
const NOT_ENABLED =
  /not (yet )?(been )?(enabled|activated|set up|onboarded)|isn't (enabled|set up)|signed up for|sign up for|must (first )?(sign up|apply|enable|activate|be onboarded)|need to (sign up|apply|enable|activate)|does not have access to (this|the) (feature|product|api)|not available (to|for|in) (your|this) account|request access|has not been granted access|is not supported for your account|only available (to|for) (platforms|accounts)/i;
const PERMISSION = /does not have the required permissions|permission_error|restricted key/i;

/** Turn a feature-not-enabled / missing-permission failure into a clear message. */
export function featureMessage(path: string, status: number, summary: string): string | undefined {
  const family = path.replace(/^\/v1\//, "").split("/")[0] ?? path;
  if ((status === 400 || status === 403 || status === 404) && NOT_ENABLED.test(summary)) {
    return `stripe: ${family} is not enabled on this Stripe account (GET ${path} failed with HTTP ${status}: ${summary})`;
  }
  if (status === 403 && PERMISSION.test(summary)) {
    return `stripe: the API key has no read permission for ${family} (GET ${path} failed with HTTP 403: ${summary}); grant it Read on the restricted key`;
  }
  return undefined;
}

export interface StripeConfig {
  apiKey: string;
  baseUrl: string;
  stripeAccount?: string;
  apiVersion: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize and check a base URL: https, or http only for a loopback fixture server. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new StripeError(`stripe secret: base_url '${raw}' is not a URL (expected e.g. https://api.stripe.com)`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new StripeError(
      "stripe secret: base_url must use https:// (http:// is accepted only for 127.0.0.1/localhost)",
    );
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

let warnedSecretKey = false;

/** Check the shape of an API key: secret (sk_) or restricted (rk_), never publishable. */
export function checkApiKey(key: string): void {
  if (/^pk_/.test(key)) {
    throw new StripeError(
      "stripe secret: api_key is a publishable key (pk_…), which cannot read data; use a restricted key (rk_…) with read permissions",
    );
  }
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9_]+$/.test(key)) {
    throw new StripeError("stripe secret: api_key must be a Stripe secret (sk_…) or restricted (rk_…) key");
  }
  if (key.startsWith("sk_") && !warnedSecretKey) {
    warnedSecretKey = true;
    log.info(
      "stripe: using a full secret key; this worker only reads, so a restricted key (rk_…) with read permissions is safer",
    );
  }
}

/**
 * Build the client config from the `stripe` secret DuckDB resolved for this call.
 * `stripeAccount` (a per-query override from a named argument) wins over the secret's.
 */
export function configFromSecrets(
  secrets: Record<string, Record<string, unknown>>,
  stripeAccount?: string | null,
): StripeConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new StripeError(
      "no stripe secret: run CREATE SECRET (TYPE stripe, API_KEY 'rk_live_…') with a restricted key that has read permissions",
    );
  }
  const apiKey = str(s.api_key);
  if (!apiKey) throw new StripeError("stripe secret: api_key is required (a restricted rk_… or secret sk_… key)");
  checkApiKey(apiKey);
  const account = str(stripeAccount ?? undefined) ?? str(s.stripe_account);
  if (account && !/^acct_[A-Za-z0-9]+$/.test(account)) {
    throw new StripeError(`stripe_account '${account}' is not a Stripe account id (acct_…)`);
  }
  const apiVersion = str(s.api_version) ?? STRIPE_API_VERSION;
  if (!/^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/.test(apiVersion)) {
    throw new StripeError(
      `stripe secret: api_version '${apiVersion}' is not a Stripe API version (e.g. 2026-09-30.endive)`,
    );
  }
  return {
    apiKey,
    baseUrl: normalizeBaseUrl(str(s.base_url) ?? DEFAULT_BASE_URL),
    stripeAccount: account,
    apiVersion,
  };
}

/** A query parameter value: scalars, arrays (`k[]=`) and one level of objects (`k[sub]=`). */
export type QueryValue = string | number | boolean | string[] | Record<string, string | number> | undefined | null;

/** Encode Stripe's bracketed form parameters (stable key order for reproducible URLs). */
export function encodeQuery(query: Record<string, QueryValue>): string {
  const parts: string[] = [];
  const enc = encodeURIComponent;
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) parts.push(`${enc(`${k}[]`)}=${enc(item)}`);
    } else if (typeof v === "object") {
      for (const [sub, sv] of Object.entries(v)) parts.push(`${enc(`${k}[${sub}]`)}=${enc(String(sv))}`);
    } else {
      parts.push(`${enc(k)}=${enc(String(v))}`);
    }
  }
  return parts.join("&");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The backoff before retry `attempt` (1-based): Retry-After if given, else 0.5 s · 2^(n-1) with jitter. */
export function retryDelayMs(headers: Headers, attempt: number, random = Math.random()): number {
  const retry = headers.get("Retry-After");
  if (retry && /^\d+(\.\d+)?$/.test(retry)) return Math.min(Number(retry) * 1000, MAX_WAIT_MS);
  const base = 500 * 2 ** (attempt - 1);
  return Math.min(base * (0.75 + random * 0.5), MAX_WAIT_MS);
}

/** Whether a failed response should be retried (Stripe-Should-Retry overrides the status rule). */
export function shouldRetry(status: number, headers: Headers): boolean {
  const hint = headers.get("Stripe-Should-Retry");
  if (hint === "true") return true;
  if (hint === "false") return false;
  return status === 429 || status === 409 || status >= 500;
}

/**
 * GET one Stripe resource. `path` is an API path (`/v1/charges`); the response body is
 * returned parsed.
 */
export async function stripeGet(
  cfg: StripeConfig,
  path: string,
  query: Record<string, QueryValue> = {},
): Promise<unknown> {
  const qs = encodeQuery(query);
  const url = `${cfg.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    "User-Agent": USER_AGENT,
    "Stripe-Version": cfg.apiVersion,
  };
  if (cfg.stripeAccount) headers["Stripe-Account"] = cfg.stripeAccount;

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new StripeError(`GET ${redact(url)} failed: ${(err as Error).message}`);
      await sleep(retryDelayMs(new Headers(), attempt));
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        throw new StripeError(`GET ${redact(url)}: response was not JSON`);
      }
    }
    if (!shouldRetry(res.status, res.headers) || attempt >= MAX_ATTEMPTS) {
      const { summary, code } = await errorSummary(res);
      const friendly = featureMessage(path, res.status, summary);
      throw new StripeError(
        friendly ?? `GET ${redact(url)} failed with HTTP ${res.status}: ${summary}`,
        res.status,
        code,
      );
    }
    await res.body?.cancel();
    const delay = retryDelayMs(res.headers, attempt);
    log.debug(`stripe: HTTP ${res.status} for ${redact(url)}; retry ${attempt} in ${Math.round(delay)} ms`);
    await sleep(delay);
  }
}

/** Stripe errors are `{error: {type, code, message, param, request_log_url}}`. */
async function errorSummary(res: Response): Promise<{ summary: string; code?: string }> {
  const text = await res.text();
  const reqId = res.headers.get("Request-Id");
  try {
    const j = JSON.parse(text) as { error?: { type?: string; code?: string; message?: string; param?: string } };
    const e = j.error ?? {};
    const parts = [e.type, e.code, e.message, e.param ? `(param: ${e.param})` : undefined, reqId ? `[${reqId}]` : ""];
    return { summary: parts.filter(Boolean).join(" ") || text.slice(0, 300), code: e.code };
  } catch {
    return { summary: text.slice(0, 300) };
  }
}

/** Show the path + query of a URL in errors (the key is a header, never in a URL). */
function redact(url: string): string {
  const u = new URL(url);
  return decodeURIComponent(`${u.pathname}${u.search}`);
}
