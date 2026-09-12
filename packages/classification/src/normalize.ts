/**
 * Raw bank descriptor → canonical `lower_snake` entity key.
 *
 * Pure, deterministic, no clock and no network. The generator already emits
 * `merchant_normalized`; this exists for real bank rows (and for tests) so the
 * same descriptor always collapses to the same entity key used by drivers and
 * what-if (`aws`, `figma`, `ashby`, …).
 */

/** Canonical keys for vendors whose descriptors never tokenize cleanly. Checked in order against the whole lowercased descriptor. */
export const MERCHANT_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(aws|amazon web services)\b/, "aws"],
  [/\bgoogle cloud\b|\bgcp\b/, "gcp"],
  [/\bgoogle workspace\b|\bg ?suite\b/, "google_workspace"],
  [/\bmicrosoft azure\b|\bazure\b/, "azure"],
  [/\bgusto\b/, "gusto_payroll"],
  [/\bstripe\b[\s*_-]*payouts?\b|payouts?[\s*_-]*\bstripe\b/, "stripe_payouts"],
  [/\buber[\s*_-]*eats\b|\bubereats\b/, "uber_eats"],
  [/\bdoordash\b/, "doordash"],
  [/\bwework\b/, "wework"],
  [/\binternal transfer\b|\bbook transfer\b|\btransfer (to|from) (savings|checking|reserve)\b/, "internal_transfer"],
  [/\bcard (payment|settlement)\b|\bpayment to card\b/, "card_settlement"],
];

/** `PREFIX*MERCHANT` descriptors where the real merchant follows the `*`. */
const AGGREGATOR_PREFIXES = new Set(["sq", "tst", "sp", "py", "pp", "paypal", "pos", "ext", "iat", "chk", "ach", "vsi"]);

/** Descriptor boilerplate. Dropped wherever it appears. */
const NOISE_TOKENS = new Set([
  "com",
  "www",
  "http",
  "https",
  "purchase",
  "payment",
  "pymt",
  "pmt",
  "debit",
  "credit",
  "recur",
  "recurring",
  "autopay",
  "bill",
  "billing",
  "invoice",
  "inv",
  "ref",
  "txn",
  "trans",
  "transaction",
  "usd",
  "nbr",
]);

/** Legal/geographic suffixes. Dropped only from the end of the token list. */
const SUFFIX_TOKENS = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "bv",
  "nv",
  "pte",
  "pty",
  "lp",
  "llp",
  "holdings",
  "technologies",
  "technology",
  "labs",
  "systems",
  "group",
  "intl",
  "international",
  "usa",
  "us",
  "hq",
]);

const US_STATE_CODES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia", "ks", "ky", "la",
  "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok",
  "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
]);

/** City words stripped only when they trail a US state code (`… SAN FRANCISCO CA`). */
const CITY_WORDS = new Set([
  "san", "francisco", "jose", "diego", "mateo", "ramon", "new", "york", "city", "brooklyn", "queens",
  "seattle", "bellevue", "redmond", "austin", "dallas", "houston", "boston", "cambridge", "chicago",
  "denver", "boulder", "los", "angeles", "palo", "alto", "mountain", "view", "menlo", "park", "sunnyvale",
  "santa", "clara", "monica", "oakland", "berkeley", "redwood", "cupertino", "atlanta", "miami", "portland",
  "nashville", "washington", "phoenix", "detroit", "minneapolis", "pittsburgh", "philadelphia", "raleigh",
  "durham", "charlotte", "columbus", "salt", "lake", "vegas", "antonio", "arbor", "ann", "north", "south",
  "east", "west", "saint", "st", "ft", "fort",
]);

/** Everything after a `PREFIX*` aggregator marker, or everything before a merchant's own `*memo`. */
function stripStarMemo(s: string): string {
  const star = s.indexOf("*");
  if (star < 0) return s;
  const before = s.slice(0, star).trim();
  const after = s.slice(star + 1).trim();
  const prefixToken = before.replace(/[^a-z0-9]/g, "");
  if (before === "" || AGGREGATOR_PREFIXES.has(prefixToken)) return after;
  return before;
}

function isReferenceNumber(token: string): boolean {
  if (/^\d+$/.test(token)) return true;
  return token.length >= 4 && /\d/.test(token) && /^[a-z0-9]+$/.test(token) && /\d{3,}/.test(token);
}

/**
 * `"ASHBYHQ INC SAN FRANCISCO CA"` → `"ashby"`.
 * Unknown descriptors fall through to generic token normalization, so the
 * result is always a stable non-empty key (worst case `unknown_merchant`).
 */
export function normalizeMerchant(raw: string): string {
  const lowered = raw.toLowerCase().trim();
  if (lowered === "") return "unknown_merchant";

  for (const [pattern, key] of MERCHANT_ALIASES) {
    if (pattern.test(lowered)) return key;
  }

  let tokens = stripStarMemo(lowered)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !NOISE_TOKENS.has(t) && !isReferenceNumber(t));

  // Trailing `… CITY ST` geography.
  if (tokens.length > 1 && US_STATE_CODES.has(tokens[tokens.length - 1]!)) {
    tokens = tokens.slice(0, -1);
    while (tokens.length > 1 && CITY_WORDS.has(tokens[tokens.length - 1]!)) tokens = tokens.slice(0, -1);
  }

  // Trailing legal suffixes.
  while (tokens.length > 1 && SUFFIX_TOKENS.has(tokens[tokens.length - 1]!)) tokens = tokens.slice(0, -1);

  // Single-character leftovers carry no signal.
  tokens = tokens.filter((t) => t.length > 1);
  if (tokens.length === 0) return "unknown_merchant";

  const key = tokens.slice(0, 3).join("_");
  // Glued brand suffix: `ashbyhq` → `ashby`.
  return key.length > 4 && key.endsWith("hq") ? key.slice(0, -2) : key;
}
