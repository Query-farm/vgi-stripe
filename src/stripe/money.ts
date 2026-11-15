/**
 * Stripe amounts are integers in the currency's minor unit ("cents"). This module
 * turns them into exact decimals in the major unit using each currency's exponent
 * as Stripe applies it (https://docs.stripe.com/currencies#minor-units):
 *
 * - zero-decimal currencies (JPY, KRW, VND, ...): 500 means ¥500;
 * - three-decimal currencies (BHD, JOD, KWD, OMR, TND): 1500 means 1.500 KWD;
 * - every other currency, including Stripe's special cases ISK, HUF, TWD and UGX,
 *   which Stripe represents with two decimals for backwards compatibility.
 *
 * Every `*_decimal` column is DECIMAL(38,3) so one column type fits all
 * currencies; unit prices with sub-minor-unit precision use DECIMAL(38,12).
 */

/** Currencies Stripe treats as zero-decimal. */
export const ZERO_DECIMAL = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

/** Currencies Stripe treats as three-decimal. */
export const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

/** Scale of every `*_decimal` amount column. */
export const AMOUNT_SCALE = 3;
/** Scale of the precise unit-price columns. */
export const UNIT_SCALE = 12;

/** Number of minor-unit digits Stripe uses for `currency` (lowercase or uppercase ISO code). */
export function currencyExponent(currency: string): number {
  const c = currency.toLowerCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/**
 * A minor-unit integer amount as the unscaled value of a DECIMAL(38, scale) in the
 * major unit, or null when either input is missing.
 */
export function minorToDecimal(amount: unknown, currency: unknown, scale = AMOUNT_SCALE): bigint | null {
  if (typeof currency !== "string" || currency === "") return null;
  let minor: bigint;
  if (typeof amount === "number" && Number.isInteger(amount)) minor = BigInt(amount);
  else if (typeof amount === "bigint") minor = amount;
  else return null;
  const exp = currencyExponent(currency);
  return minor * 10n ** BigInt(scale - exp);
}

/**
 * A Stripe `*_decimal` string (minor units with up to 12 fractional digits, e.g.
 * `"1234.5"` = 12.345 USD) as the unscaled value of a DECIMAL(38, scale) in the major
 * unit. Digits beyond the scale are truncated toward zero.
 */
export function minorStringToDecimal(value: unknown, currency: unknown, scale = UNIT_SCALE): bigint | null {
  if (typeof currency !== "string" || currency === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const [, sign, whole, frac = ""] = m;
  const exp = currencyExponent(currency);
  // minor = whole.frac ; major = minor / 10^exp ; unscaled = major * 10^scale
  const shift = scale - exp;
  if (shift < 0) return null;
  const fracDigits = (frac + "0".repeat(shift)).slice(0, shift);
  const unscaled = BigInt(whole as string) * 10n ** BigInt(shift) + BigInt(fracDigits || "0");
  return sign === "-" ? -unscaled : unscaled;
}
