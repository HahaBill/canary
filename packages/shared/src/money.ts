/**
 * Deterministic money helpers. Integer cents in, integer cents out.
 * Speech-friendly strings are produced here — never by an LLM.
 */
import { WEEKS_PER_MONTH } from "./config.ts";
import type { Cents } from "./types.ts";

export function assertCents(v: number, label = "value"): void {
  if (!Number.isInteger(v)) throw new Error(`${label} must be integer cents, got ${v}`);
}

export function weeklyToMonthly(weeklyCents: Cents): Cents {
  return Math.round(weeklyCents * WEEKS_PER_MONTH);
}

export function monthlyToWeekly(monthlyCents: Cents): Cents {
  return Math.round(monthlyCents / WEEKS_PER_MONTH);
}

export function weeklyToAnnual(weeklyCents: Cents): Cents {
  return Math.round(weeklyCents * 52);
}

export function monthlyToAnnual(monthlyCents: Cents): Cents {
  return Math.round(monthlyCents * 12);
}

/**
 * Runway in months, rounded to 1 decimal. `null` when monthly net burn ≤ 0.
 */
export function runwayMonths(availableCashCents: Cents, monthlyNetBurnCents: Cents): number | null {
  if (monthlyNetBurnCents <= 0) return null;
  return Math.round((availableCashCents / monthlyNetBurnCents) * 10) / 10;
}

export function sumCents(values: Iterable<Cents>): Cents {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of empty array");
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Median absolute deviation (unscaled). */
export function mad(values: number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/** MAD scaled to be a consistent σ estimator for normal data. */
export const MAD_TO_SIGMA = 1.4826;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** `$1,234.56` */
export function formatUsd(cents: Cents): string {
  return usd.format(cents / 100);
}

/** `$1,235` */
export function formatUsdWhole(cents: Cents): string {
  return usd0.format(Math.round(cents / 100));
}

/** `$1.2M`, `$39.4K`, `$850` */
export function formatUsdCompact(cents: Cents): string {
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  const sign = dollars < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${trimZero((abs / 1_000_000).toFixed(2))}M`;
  if (abs >= 10_000) return `${sign}$${trimZero((abs / 1_000).toFixed(1))}K`;
  if (abs >= 1_000) return `${sign}$${trimZero((abs / 1_000).toFixed(2))}K`;
  return `${sign}$${Math.round(abs)}`;
}

function trimZero(s: string): string {
  return s.replace(/\.?0+$/, "");
}

/** `+$3,900/mo` or `-$3,900/mo` */
export function formatSignedUsd(cents: Cents, suffix = ""): string {
  const sign = cents > 0 ? "+" : cents < 0 ? "-" : "";
  return `${sign}${formatUsdWhole(Math.abs(cents))}${suffix}`;
}

export function formatMonths(months: number | null): string {
  if (months === null) return "not burning";
  return `${months.toFixed(1)} months`;
}

// ---------------------------------------------------------------------------
// Speech-friendly rendering (for ElevenLabs / iMessage)
// ---------------------------------------------------------------------------

const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function wordsUnder1000(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? "-" + ONES[n % 10] : "");
  const h = Math.floor(n / 100);
  const r = n % 100;
  return ONES[h]! + " hundred" + (r ? " " + wordsUnder1000(r) : "");
}

/** Whole-number words up to the billions. */
export function numberToWords(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  n = Math.round(Math.abs(n));
  if (n === 0) return "zero";
  const parts: string[] = [];
  const units: Array<[number, string]> = [
    [1_000_000_000, "billion"],
    [1_000_000, "million"],
    [1_000, "thousand"],
  ];
  for (const [v, name] of units) {
    if (n >= v) {
      parts.push(wordsUnder1000(Math.floor(n / v)) + " " + name);
      n %= v;
    }
  }
  if (n > 0) parts.push(wordsUnder1000(n));
  return parts.join(" ");
}

/** Round to 2 significant digits for speech ("about thirty-nine hundred dollars"). */
export function roundForSpeech(dollars: number): number {
  const abs = Math.abs(dollars);
  if (abs < 100) return Math.round(dollars);
  const magnitude = Math.pow(10, Math.floor(Math.log10(abs)) - 1);
  return Math.round(dollars / magnitude) * magnitude;
}

/**
 * "about thirty-nine hundred dollars", "about one point two million dollars",
 * "about eighteen thousand dollars". Sign is expressed as a prefix word.
 */
export function speakUsd(cents: Cents, { approx = true }: { approx?: boolean } = {}): string {
  const dollars = roundForSpeech(cents / 100);
  const abs = Math.abs(dollars);
  const prefix = approx ? "about " : "";
  const sign = dollars < 0 ? "minus " : "";
  let body: string;
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000;
    body = m % 1 === 0 ? `${numberToWords(m)} million dollars` : `${numberToWords(Math.floor(m))} point ${numberToWords(Math.round((m % 1) * 10))} million dollars`;
  } else if (abs >= 1_000 && abs < 10_000 && abs % 100 === 0) {
    body = `${wordsUnder1000(abs / 100)} hundred dollars`;
  } else {
    body = `${numberToWords(abs)} dollars`;
  }
  return `${prefix}${sign}${body}`;
}

/** "about fourteen months", "about thirteen and a half months", "not burning cash" */
export function speakMonths(months: number | null): string {
  if (months === null) return "not currently burning cash";
  const whole = Math.floor(months);
  const frac = months - whole;
  if (frac < 0.25) return `about ${numberToWords(whole)} months`;
  if (frac < 0.75) return `about ${numberToWords(whole)} and a half months`;
  return `about ${numberToWords(whole + 1)} months`;
}

/** "twenty percent lower" / "ten percent higher" */
export function speakPercentage(pct: number): string {
  const abs = Math.abs(Math.round(pct));
  return `${numberToWords(abs)} percent ${pct < 0 ? "lower" : "higher"}`;
}
