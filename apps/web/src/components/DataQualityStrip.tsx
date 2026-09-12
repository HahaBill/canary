import { AlertCircle, Check } from "lucide-react";
import { useState } from "react";
import type { DerivedDemoObject, ReconciliationReport } from "@canary/shared";
import { NeedsReviewDialog } from "@/components/NeedsReviewDialog.tsx";
import { formatSignedUsd, formatUsdWhole } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Proof that the numbers were reconciled before anything was detected:
 * transfers paired, card settlements matched, superseded pending rows dropped,
 * and anything unclassified surfaced rather than silently ignored.
 */
export function DataQualityStrip({
  reconciliation,
  needsReview,
}: {
  reconciliation: ReconciliationReport;
  needsReview: DerivedDemoObject["needs_review"];
}) {
  const [open, setOpen] = useState(false);

  const transfersOk = reconciliation.unpaired_transfer_legs === 0;
  const settlementsOk = reconciliation.unpaired_settlements === 0;

  return (
    <section aria-label="Data quality" className="rounded-2xl border border-neutral-200/80 bg-white p-4 sm:p-5">
      <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Data quality</h2>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Item
          tone={reconciliation.matches ? "ok" : "warn"}
          label={reconciliation.matches ? "Reconciled" : "Reconciliation mismatch"}
          caption={
            reconciliation.matches
              ? "reported vs computed closing cash"
              : `${formatSignedUsd(reconciliation.discrepancy_cents)} reported minus computed`
          }
          note={
            reconciliation.opening_balance_reported
              ? "opening balance from bank statement"
              : "opening balance derived"
          }
        />
        <Item
          tone={transfersOk ? "ok" : "bad"}
          label={`${reconciliation.internal_transfer_pairs} transfers paired`}
          caption={transfersOk ? "no unpaired legs" : `${reconciliation.unpaired_transfer_legs} unpaired legs`}
        />
        <Item
          tone={settlementsOk ? "ok" : "bad"}
          label={`${reconciliation.card_settlements} settlements paired`}
          caption={
            settlementsOk
              ? `${reconciliation.card_purchases_covered} card purchases covered`
              : `${reconciliation.unpaired_settlements} unpaired`
          }
        />
        <Item
          tone="ok"
          label={`${reconciliation.pending_rows_dropped} pending dropped`}
          caption="superseded by settled rows"
        />
        <Item
          tone="ok"
          label={`${formatUsdWhole(reconciliation.refunds_netted_cents)} refunds netted`}
          caption="credited against the vendor's spend"
        />

        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            "rounded-xl border p-3 text-left transition-colors",
            needsReview.count > 0
              ? "border-amber-200 bg-amber-50/60 hover:bg-amber-50"
              : "border-neutral-200 hover:bg-neutral-50",
          )}
        >
          <span className="flex items-center gap-1.5 text-sm font-medium text-neutral-900">
            {needsReview.count > 0 ? (
              <AlertCircle className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
            ) : (
              <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
            )}
            {needsReview.count} Needs Review
          </span>
          <span className="mt-0.5 block text-xs text-neutral-500">
            {formatUsdWhole(needsReview.outflow_cents)} · still counted in burn
          </span>
        </button>
      </div>

      {reconciliation.warnings.length > 0 ? (
        <details className="mt-3 rounded-xl border border-amber-200 bg-amber-50/50 px-3 py-2">
          {/* Padding rather than `min-h` + flex: `display:flex` on a summary drops the marker. */}
          <summary className="cursor-pointer text-xs font-medium text-amber-900 pointer-coarse:py-3.5">
            Notes ({reconciliation.warnings.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs leading-relaxed text-neutral-600">
            {reconciliation.warnings.map((warning) => (
              <li key={warning} className="flex gap-1.5">
                <span aria-hidden="true">·</span>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <NeedsReviewDialog
        open={open}
        onOpenChange={setOpen}
        count={needsReview.count}
        items={needsReview.items}
        outflowCents={needsReview.outflow_cents}
      />
    </section>
  );
}

/**
 * `warn` is for a reconciliation that did not balance: the figures are still
 * usable and the discrepancy is stated, so it reads as amber rather than red.
 * `bad` is for pairing that failed outright.
 */
type Tone = "ok" | "warn" | "bad";

function Item({
  tone,
  label,
  caption,
  note,
}: {
  tone: Tone;
  label: string;
  caption: string;
  note?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        tone === "ok" && "border-neutral-200",
        tone === "warn" && "border-amber-200 bg-amber-50/60",
        tone === "bad" && "border-rose-200 bg-rose-50/60",
      )}
    >
      <p className="flex items-center gap-1.5 text-sm font-medium text-neutral-900">
        {tone === "ok" ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
        ) : (
          <AlertCircle
            className={cn("h-3.5 w-3.5 shrink-0", tone === "warn" ? "text-amber-600" : "text-rose-600")}
            aria-hidden="true"
          />
        )}
        {label}
      </p>
      <p className="mt-0.5 text-xs text-neutral-500">{caption}</p>
      {note ? <p className="mt-0.5 text-[11px] text-neutral-400">{note}</p> : null}
    </div>
  );
}
