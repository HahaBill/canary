/**
 * The account transacting, as it happens.
 *
 * Cash falling is the truth, but a single number ticking down is a weak signal:
 * a viewer cannot tell a live system from a static page by staring at one
 * figure. This shows the ROWS behind the figure — the payments that moved it —
 * arriving one at a time as the demo clock reaches their date.
 *
 * Nothing here is animated into existence on a timer. A row appears when the
 * backend starts returning it, which is the moment that transaction posted in
 * the company's ledger. If the clock were frozen, this list would be still, and
 * that would be the correct thing to show.
 */
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ISODate, Transaction } from "@canary/shared";
import { useRecentTransactions } from "@/api/useDerived.ts";
import { PanelSkeleton } from "@/components/States.tsx";
import { entityDisplayName, formatDateMedium, formatUsdWhole } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

/** Newest first, and only what a glance can absorb. */
const SHOWN = 7;

function orderNewestFirst(transactions: Transaction[]): Transaction[] {
  // The bank endpoint deliberately returns raw activity, including pending
  // authorisations. Once the same response contains the settled replacement,
  // keep only that replacement in this compact feed; showing both reads as two
  // charges even though the reconciled ledger counts them once.
  const supersededPendingIds = new Set(
    transactions.flatMap((tx) => (tx.status === "settled" && tx.pending_of ? [tx.pending_of] : [])),
  );
  return [...transactions]
    .filter((tx) => !supersededPendingIds.has(tx.id))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1))
    .slice(0, SHOWN);
}

/**
 * Ids shown on the previous render, so a genuinely new row can be highlighted.
 * The FIRST batch is not "new" — everything would flash at once and mean
 * nothing — so the initial load seeds the set without marking anything. Keep
 * only the previous batch: the demo clock replays its bounded history, and an
 * forever-growing set would make rows stop highlighting after the first loop.
 */
function useArrivals(rows: Transaction[]): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  const rowIds = rows.map((row) => row.id).join("\u0000");

  useEffect(() => {
    if (rows.length === 0) return;
    const current = new Set(rows.map((r) => r.id));
    if (seen.current === null) {
      seen.current = current;
      return;
    }
    const fresh = rows.filter((r) => !seen.current!.has(r.id)).map((r) => r.id);
    seen.current = current;
    setArrived((previous) => {
      if (fresh.length === 0) return previous.size === 0 ? previous : new Set();
      const next = new Set(fresh);
      if (previous.size === next.size && [...previous].every((id) => next.has(id))) return previous;
      return next;
    });
  }, [rowIds]);

  return arrived;
}

export function ActivityFeed({ asOf }: { asOf: ISODate | null }) {
  const { data, error } = useRecentTransactions(asOf);
  const rows = orderNewestFirst(data ?? []);
  const arrived = useArrivals(rows);

  // Optional chrome: a feed that fails must not take the dashboard with it.
  if (error) return null;
  if (!data) return <PanelSkeleton className="h-56" />;

  return (
    <section
      aria-label="Recent activity"
      className="rounded-2xl border border-neutral-200/80 bg-white p-5 shadow-sm sm:p-6"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Recent activity</h2>
        <p className="text-[11px] text-neutral-400">posting as the account moves</p>
      </div>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">Nothing has posted in the last few days.</p>
      ) : (
        <ul className="mt-3 divide-y divide-neutral-100">
          {rows.map((tx) => {
            const inflow = tx.amount_cents > 0;
            return (
              <li
                key={tx.id}
                className={cn(
                  "flex items-center gap-3 py-2.5 transition-colors duration-700",
                  arrived.has(tx.id) ? "bg-canary-50/70" : "bg-transparent",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                    inflow ? "bg-emerald-50 text-emerald-600" : "bg-neutral-100 text-neutral-500",
                  )}
                >
                  {inflow ? <ArrowDownLeft className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-neutral-900">
                    {entityDisplayName(tx.merchant_normalized)}
                  </span>
                  <span className="block truncate text-[11px] text-neutral-500">
                    {formatDateMedium(tx.date)}
                    {tx.status === "pending" ? " · pending" : null}
                  </span>
                </span>

                <span
                  className={cn(
                    "shrink-0 text-sm font-semibold tabular-nums",
                    inflow ? "text-emerald-600" : "text-neutral-900",
                  )}
                >
                  {inflow ? "+" : "−"}
                  {formatUsdWhole(Math.abs(tx.amount_cents))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
