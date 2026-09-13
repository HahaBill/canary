/**
 * The number guard: proof, not trust.
 *
 * docs/AGENT_BEHAVIOR.md §3 says every figure Canary states comes from a tool
 * call, and §4 says a plausible-but-invented figure is a fabrication rather than
 * a simplification. The system prompt says so too — but a prompt is a request.
 * This module is the enforcement: every money, percentage and month figure in a
 * generated reply must appear in the tool results of the SAME turn, rendered by
 * the same shared formatters the rest of Canary uses. Anything else and the
 * whole reply is thrown away for a deterministic one.
 *
 * URLs get the same treatment (§4: "a URL in generated prose is a defect"): only
 * links a tool actually returned survive.
 */
import {
  formatMonths,
  formatSignedUsd,
  formatUsd,
  formatUsdCompact,
  formatUsdWhole,
  speakMonths,
  speakPercentage,
  speakUsd,
} from "@canary/shared";

/**
 * Money, percentages and month counts — the three figure shapes Canary says.
 * Each number must END on a digit, so the comma in "…$76,067, and runway…" is
 * punctuation rather than part of the figure.
 */
const NUMBER = String.raw`\d(?:[\d,]*\d)?(?:\.\d+)?`;
const MONEY_RE = new RegExp(String.raw`[-+]?\$\s?${NUMBER}(?:\s?[KMB]\b)?`, "g");
const PERCENT_RE = new RegExp(String.raw`${NUMBER}\s?(?:%|percent\b)`, "gi");
const MONTHS_RE = new RegExp(String.raw`${NUMBER}\s*-?\s*months?\b`, "gi");
const URL_RE = /https?:\/\/[^\s<>()[\]"']+/g;
/** Internal ids must never reach the founder (docs/AGENT_BEHAVIOR.md §4 / prompt). */
const INTERNAL_ID_RE = /\binc_[0-9a-z_]+\b/gi;

export interface FigureCheck {
  ok: boolean;
  /** Figures in the reply that no tool result backs. Empty when `ok`. */
  offending: string[];
}

/**
 * Every string a figure from the tool results is allowed to appear as.
 *
 * Three sources: the tool results verbatim (they already carry formatter output
 * like `"$19,479"`), every numeric leaf rendered through each shared formatter,
 * and every money/month figure already IN that text, read back to cents and
 * re-rendered the same way. The third is what lets a model restyle `$19,479` as
 * `$19,479.00` or `$19.5K` without tripping the guard — it is the same number,
 * and refusing it would replace a true reply with a canned one.
 */
export function allowedFigureText(toolResults: unknown[]): string {
  const parts: string[] = [];
  for (const result of toolResults) {
    const json = JSON.stringify(result ?? null);
    parts.push(json);
    for (const n of numericLeaves(result)) parts.push(...renderEveryWay(n));
    for (const token of json.match(MONEY_RE) ?? []) {
      const cents = moneyToCents(token);
      if (cents !== null) parts.push(...renderEveryWay(cents));
    }
    for (const token of json.match(MONTHS_RE) ?? []) {
      const months = Number(token.replace(/[^\d.]/g, ""));
      if (Number.isFinite(months)) parts.push(formatMonths(months), speakMonths(months));
    }
  }
  return parts.join("\n");
}

/** `"$19.5K"` → 1_950_000 cents. Null when the token is not a clean amount. */
function moneyToCents(token: string): number | null {
  const match = /^([-+]?)\$\s?([\d,]+(?:\.\d+)?)(?:\s?([KMB]))?$/i.exec(token.trim());
  if (!match) return null;
  const magnitude = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[match[3]?.toLowerCase() ?? ""] ?? 1;
  const dollars = Number(match[2]!.replace(/,/g, "")) * magnitude;
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100) * (match[1] === "-" ? -1 : 1);
}

function numericLeaves(value: unknown, depth = 0): number[] {
  if (depth > 8) return [];
  if (typeof value === "number") return Number.isFinite(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((v) => numericLeaves(v, depth + 1));
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap((v) => numericLeaves(v, depth + 1));
  return [];
}

/** One number, in every shape `@canary/shared` can render it. Integers are read as cents. */
function renderEveryWay(n: number): string[] {
  const out = [String(n), String(Math.abs(n)), `${n}%`, `${Math.abs(n)}%`, speakPercentage(n), formatMonths(n), speakMonths(n)];
  if (Number.isInteger(n)) {
    for (const cents of [n, -n]) {
      out.push(formatUsd(cents), formatUsdWhole(cents), formatUsdCompact(cents), formatSignedUsd(cents), speakUsd(cents));
    }
  } else {
    // A non-integer is a ratio or a month count, never cents.
    out.push(formatMonths(Math.round(n * 10) / 10));
  }
  return out;
}

/** Canonical forms of one extracted figure, any of which counts as backed. */
function candidatesFor(raw: string): string[] {
  const trimmed = raw.trim();
  const collapsed = trimmed.replace(/\$\s+/, "$").replace(/\s+/g, " ");
  const out = new Set<string>([trimmed, collapsed]);
  // `+$2,999` is backed by `$2,999` and vice versa; the sign is formatting.
  if (/^[-+]/.test(collapsed)) out.add(collapsed.slice(1));
  const monthMatch = /^(\d[\d,]*(?:\.\d+)?)\s*-?\s*months?$/i.exec(collapsed);
  if (monthMatch) {
    out.add(`${monthMatch[1]} months`);
    out.add(`${monthMatch[1]} month`);
  }
  const percentMatch = /^(\d[\d,]*(?:\.\d+)?)\s?(?:%|percent)$/i.exec(collapsed);
  if (percentMatch) {
    out.add(`${percentMatch[1]}%`);
    out.add(`${percentMatch[1]} percent`);
  }
  return [...out];
}

/**
 * Substring match, but a figure may not be a PREFIX of a longer one: `$1` is
 * not backed by `$1,234` or by `$1.23K`, or a model could shave digits off a
 * real figure and still pass. Trailing cents are the one exception — `$19,479`
 * and `$19,479.00` are the same number in two formatters' shapes.
 */
const NOT_A_PREFIX = String.raw`(?![\d,])(?!\.\d*[KMB])(?!\s?[KMB]\b)`;

function backed(allowed: string, candidate: string): boolean {
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}${NOT_A_PREFIX}`, "i").test(allowed);
}

export function extractFigures(text: string): string[] {
  return [...(text.match(MONEY_RE) ?? []), ...(text.match(PERCENT_RE) ?? []), ...(text.match(MONTHS_RE) ?? [])];
}

/** Does every figure in `reply` appear in the tool results of this turn? */
export function checkFigures(reply: string, toolResults: unknown[]): FigureCheck {
  const allowed = allowedFigureText(toolResults);
  const offending = extractFigures(reply).filter((figure) => !candidatesFor(figure).some((c) => backed(allowed, c)));
  return { ok: offending.length === 0, offending: [...new Set(offending)] };
}

/**
 * Removes links the model wrote itself and any internal id left in the prose.
 * Tool-issued URLs are lifted out first so stripping ids cannot corrupt one.
 */
export function stripUnknownUrls(reply: string, allowedUrls: readonly string[]): string {
  const allowed = new Set(allowedUrls);
  const kept: string[] = [];

  const withPlaceholders = reply.replace(URL_RE, (url) => {
    const bare = url.replace(/[.,;:]+$/, "");
    if (!allowed.has(bare) && !allowed.has(url)) return "";
    kept.push(bare);
    return `\u0000${kept.length - 1}\u0000`;
  });

  return withPlaceholders
    .replace(INTERNAL_ID_RE, "")
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,!?])/g, "$1")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}
