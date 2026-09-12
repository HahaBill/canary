import type { NeedsReviewItem } from "@canary/shared";
import { Link } from "react-router-dom";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { formatDateMedium, formatSignedUsd, formatUsdWhole } from "@/lib/format.ts";

export function NeedsReviewDialog({
  open,
  onOpenChange,
  count,
  items,
  outflowCents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Authoritative count from the reconciliation report; `items` may be a subset. */
  count: number;
  items: NeedsReviewItem[];
  outflowCents: number;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="needs-review-description">
        <DialogHeader>
          <DialogTitle>Needs Review</DialogTitle>
          <DialogDescription id="needs-review-description">
            {count === 1 ? "1 transaction" : `${count} transactions`} totalling{" "}
            {formatUsdWhole(outflowCents)} could not be corroborated. The amounts still count in cash and
            burn.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {items.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing is waiting for review.</p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {items.map((item) => (
                <li key={item.transaction_id} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-neutral-900">{item.merchant_raw}</p>
                      <p className="text-xs text-neutral-500">
                        {formatDateMedium(item.date)} · {item.merchant_normalized}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-neutral-900">
                      {formatSignedUsd(item.amount_cents)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-neutral-500">{item.reason}</p>
                </li>
              ))}
            </ul>
          )}

          <Link
            to="/needs-review"
            onClick={() => onOpenChange(false)}
            className="mt-4 inline-block text-sm font-medium text-neutral-900 underline-offset-4 hover:underline"
          >
            Review and assign categories →
          </Link>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
