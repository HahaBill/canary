import { AlertCircle, Check } from "lucide-react";
import { useState } from "react";
import type { DerivedDemoObject, ReconciliationReport } from "@canary/shared";
import { NeedsReviewDialog } from "@/components/NeedsReviewDialog.tsx";
import { formatUsdWhole } from "@/lib/format.ts";
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

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Item
          ok={reconciliation.matches}
          label={reconciliation.matches ? "Reconciled" : "Reconciliation mismatch"}
          caption="reported vs computed closing cash"
        />
        <Item
          ok={transfersOk}
          label={`${reconciliation.internal_transfer_pairs} transfers paired`}
          caption={transfersOk ? "no unpaired legs" : `${reconciliation.unpaired_transfer_legs} unpaired legs`}
        />
        <Item
          ok={settlementsOk}
          label={`${reconciliation.card_settlements} settlements paired`}
          caption={
            settlementsOk
              ? `${reconciliation.card_purchases_covered} card purchases covered`
              : `${reconciliation.unpaired_settlements} unpaired`
          }
        />
        <Item
          ok
          label={`${reconciliation.pending_rows_dropped} pending dropped`}
          caption="superseded by settled rows"
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

function Item({ ok, label, caption }: { ok: boolean; label: string; caption: string }) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        ok ? "border-neutral-200" : "border-rose-200 bg-rose-50/60",
      )}
    >
      <p className="flex items-center gap-1.5 text-sm font-medium text-neutral-900">
        {ok ? (
          <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
        ) : (
          <AlertCircle className="h-3.5 w-3.5 text-rose-600" aria-hidden="true" />
        )}
        {label}
      </p>
      <p className="mt-0.5 text-xs text-neutral-500">{caption}</p>
    </div>
  );
}
