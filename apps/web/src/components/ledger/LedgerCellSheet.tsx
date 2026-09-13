import type { PivotGranularity } from "@canary/shared";
import { useLedgerCell } from "@/api/useDerived.ts";
import type { CellCoordinates } from "@/components/ledger/LedgerTable.tsx";
import { ErrorState } from "@/components/States.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import {
  SideSheet,
  SideSheetBody,
  SideSheetContent,
  SideSheetDescription,
  SideSheetHeader,
  SideSheetTitle,
} from "@/components/ui/side-sheet.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  categoryLabel,
  entityDisplayName,
  formatDateMedium,
  formatSignedUsd,
  formatPivotAmount,
} from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

/**
 * The transactions behind one vendor × period cell. Fetched lazily: the inner
 * component only mounts while the sheet is open, so browsing the sheet never
 * fires a request.
 */
export function LedgerCellSheet({
  coordinates,
  granularity,
  periodLabel,
  onClose,
}: {
  coordinates: CellCoordinates | null;
  granularity: PivotGranularity;
  periodLabel: string;
  onClose: () => void;
}) {
  const open = coordinates !== null;
  const vendor = coordinates ? entityDisplayName(coordinates.row.entity ?? coordinates.row.label) : "";

  return (
    <SideSheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      {coordinates ? (
        <SideSheetContent aria-describedby="ledger-cell-description">
          <SideSheetHeader>
            <SideSheetTitle>
              {vendor} · {periodLabel}
            </SideSheetTitle>
            <SideSheetDescription id="ledger-cell-description">
              {formatPivotAmount(coordinates.row.section, coordinates.cell.amount_cents)}
              {categoryLabel(coordinates.row.category) ? ` · ${categoryLabel(coordinates.row.category)}` : ""}
            </SideSheetDescription>
          </SideSheetHeader>
          <SideSheetBody>
            <CellTransactions
              rowId={coordinates.row.id}
              periodKey={coordinates.period.key}
              granularity={granularity}
            />
          </SideSheetBody>
        </SideSheetContent>
      ) : null}
    </SideSheet>
  );
}

function CellTransactions({
  rowId,
  periodKey,
  granularity,
}: {
  rowId: string;
  periodKey: string;
  granularity: PivotGranularity;
}) {
  const { data, loading, error, reload } = useLedgerCell(rowId, periodKey, granularity);

  if (error) return <ErrorState message={error} onRetry={reload} />;

  // Keep the rows a reader is looking at; the heartbeat must not blank them.
  if (!data) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  }

  if (data.transactions.length === 0) {
    return <p className="text-sm text-neutral-500">No transactions posted in this period.</p>;
  }

  return (
    <ul className="divide-y divide-neutral-100">
      {data.transactions.map((tx) => (
        <li key={tx.id} className="py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p
                className={cn(
                  "truncate text-sm font-medium text-neutral-900",
                  tx.dropped ? "line-through decoration-neutral-400" : null,
                )}
              >
                {tx.merchant_raw}
              </p>
              <p className="mt-0.5 text-xs text-neutral-500">
                {formatDateMedium(tx.date)} · {categoryLabel(tx.category) ?? tx.category}
              </p>
            </div>
            <span
              className={cn(
                "shrink-0 text-sm font-semibold tabular-nums text-neutral-900",
                tx.dropped ? "line-through decoration-neutral-400 text-neutral-400" : null,
              )}
            >
              {formatSignedUsd(tx.amount_cents)}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">{tx.description}</p>
          {tx.tags.length > 0 || tx.dropped ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {tx.tags.map((tag) => (
                <Badge key={tag} variant={tag === "needs_review" ? "warn" : "quiet"}>
                  {tag.replace(/_/g, " ")}
                </Badge>
              ))}
              {tx.dropped ? <Badge variant="quiet">dropped — superseded pending row</Badge> : null}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
