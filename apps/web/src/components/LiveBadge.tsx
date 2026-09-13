/**
 * On-screen proof that Canary is watching a moving account, not a snapshot.
 *
 * The backend's demo clock advances the company's "today" one simulated day per
 * real minute, and the heartbeat in `useDerived` re-fetches so the new day lands
 * in place. Without something saying so, all a viewer sees is a number that was
 * slightly different a minute ago — indistinguishable from a page that never
 * changes. This badge names the movement: how far the clock has run since the
 * viewer arrived, and what cash did over that span.
 *
 * Every figure here is a difference between two observations the API returned.
 * Nothing is hand-typed, and the component never does money math beyond the
 * subtraction of two integer-cent readings, formatted by the shared helpers.
 */
import { useEffect, useRef, useState } from "react";
import { daysBetween, formatSignedUsd, type Cents, type DataProvenance, type ISODate } from "@canary/shared";
import { formatDateMedium } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

export interface LiveObservation {
  date: ISODate;
  cash_cents: Cents;
}

export interface LiveState {
  /** The reading every delta is measured from. */
  baseline: LiveObservation;
  /** Simulated days the clock has run since the baseline. */
  days_elapsed: number;
  /** Cash movement since the baseline, or `null` while there is nothing to compare. */
  delta_cents: Cents | null;
  /** The demo clock wrapped back to the start of its cycle on this observation. */
  restarted: boolean;
}

/**
 * Fold one new reading into the running comparison.
 *
 * THE WRAP CASE IS THE WHOLE REASON THIS IS A FUNCTION. The demo clock runs a
 * ten-minute cycle and then returns to the end of history, so the simulated date
 * jumps backwards and cash jumps back up with it. Measured naively that reads as
 * the company earning a week's spend every ten minutes. Treating a backwards
 * date as a new baseline reports the truth instead: the clock restarted, and
 * there is nothing to compare yet.
 */
export function advanceLive(baseline: LiveObservation | null, observed: LiveObservation): LiveState {
  if (!baseline || observed.date < baseline.date) {
    return { baseline: observed, days_elapsed: 0, delta_cents: null, restarted: baseline !== null };
  }

  const days = daysBetween(baseline.date, observed.date);
  if (days === 0) {
    // Same simulated day. Cash may have moved by a transaction posting within
    // the day, but "over 0 days" is not a sentence, so hold the previous line.
    return { baseline, days_elapsed: 0, delta_cents: null, restarted: false };
  }

  return {
    baseline,
    days_elapsed: days,
    delta_cents: observed.cash_cents - baseline.cash_cents,
    restarted: false,
  };
}

/**
 * Holds the baseline across renders so the badge can report movement.
 *
 * The baseline lives in a ref rather than state because writing it must not
 * itself schedule a render; the state below is what the badge reads.
 */
export function useLiveClock(date: ISODate, cashCents: Cents): LiveState {
  const baselineRef = useRef<LiveObservation | null>(null);
  const [state, setState] = useState<LiveState>(() => advanceLive(null, { date, cash_cents: cashCents }));

  useEffect(() => {
    const next = advanceLive(baselineRef.current, { date, cash_cents: cashCents });
    baselineRef.current = next.baseline;
    setState(next);
  }, [date, cashCents]);

  return state;
}

/** `1 day` / `4 days` — the badge's only pluralisation. */
function dayCount(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

export function LiveBadge({
  provenance,
  cashCents,
  refreshing,
}: {
  provenance: DataProvenance;
  cashCents: Cents;
  /** A heartbeat fetch is in flight; the dot brightens so the page looks awake. */
  refreshing?: boolean;
}) {
  const state = useLiveClock(provenance.end_date, cashCents);

  const movement =
    state.days_elapsed > 0 && state.delta_cents !== null
      ? `${formatSignedUsd(state.delta_cents)} over ${dayCount(state.days_elapsed)}`
      : state.restarted
        ? "clock restarted"
        : "watching";

  return (
    <span
      // Announced politely so a screen reader hears the account move without
      // having the current sentence interrupted twice a minute.
      aria-live="polite"
      className="flex shrink-0 items-center gap-1.5 text-[11px] leading-snug text-neutral-500 sm:text-xs"
    >
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
        {refreshing ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        ) : null}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full",
            refreshing ? "bg-emerald-500" : "bg-emerald-400",
          )}
        />
      </span>
      <span className="font-medium text-neutral-600">Live</span>
      <span className="tabular-nums">
        {formatDateMedium(provenance.end_date)} · {movement}
      </span>
    </span>
  );
}
