import { useEffect, useMemo, useState } from "react";
import type { LedgerPivot, PivotCell, PivotPeriod, PivotRow } from "@canary/shared";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { CellFlags } from "@/components/ledger/CellFlags.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import {
  entityDisplayName,
  formatDateMedium,
  formatMonthShort,
  formatPivotAmount,
  formatWeekLabel,
} from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

export interface CellCoordinates {
  row: PivotRow;
  period: PivotPeriod;
  cell: PivotCell;
}

const EMPTY = "–";

/** Nothing posted: no amount and no transactions behind it. */
function isEmpty(cell: PivotCell): boolean {
  return cell.amount_cents === 0 && cell.transaction_count === 0;
}

export function periodLabel(pivot: LedgerPivot, period: PivotPeriod): string {
  return pivot.granularity === "week" ? formatWeekLabel(period.start) : formatMonthShort(period.key);
}

function defaultCollapsed(pivot: LedgerPivot, revealRowIds: readonly string[]): Set<string> {
  const closed = new Set(pivot.rows.filter((row) => row.level === 1).map((row) => row.id));
  const byId = new Map(pivot.rows.map((row) => [row.id, row]));
  for (const id of revealRowIds) {
    let ancestor = byId.get(id)?.parent_id;
    while (ancestor) {
      closed.delete(ancestor);
      ancestor = byId.get(ancestor)?.parent_id;
    }
  }
  return closed;
}

export function LedgerTable({
  pivot,
  focusRowId,
  revealRowIds,
  onCellSelect,
}: {
  pivot: LedgerPivot;
  /** Row to reveal and highlight, e.g. from a `?focus=vendor:aws` deep link. */
  focusRowId?: string | undefined;
  /** Extra rows whose ancestors should stay open (agentic filter matches). */
  revealRowIds?: readonly string[] | undefined;
  /** Vendor × period cells are drillable; the page owns the detail sheet. */
  onCellSelect: (coordinates: CellCoordinates) => void;
}) {
  const reveal = useMemo(() => [...(revealRowIds ?? []), ...(focusRowId ? [focusRowId] : [])], [revealRowIds, focusRowId]);
  const revealKey = reveal.join("|");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => defaultCollapsed(pivot, reveal));

  useEffect(() => {
    setCollapsed(defaultCollapsed(pivot, reveal));
    // Only when the filter (or deep link) changes what must be visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey, pivot.granularity, pivot.rows.length]);

  const childCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of pivot.rows) {
      if (!row.parent_id) continue;
      counts.set(row.parent_id, (counts.get(row.parent_id) ?? 0) + 1);
    }
    return counts;
  }, [pivot.rows]);

  const rowsById = useMemo(() => new Map(pivot.rows.map((row) => [row.id, row])), [pivot.rows]);

  const visible = useMemo(() => {
    const hidden = (row: PivotRow): boolean => {
      let parentId = row.parent_id;
      while (parentId) {
        if (collapsed.has(parentId)) return true;
        parentId = rowsById.get(parentId)?.parent_id;
      }
      return false;
    };
    return pivot.rows.filter((row) => !hidden(row));
  }, [pivot.rows, rowsById, collapsed]);

  function toggle(rowId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  const firstPostChange = pivot.periods.findIndex((period) => period.post_change);

  return (
    <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <caption className="sr-only">
          Ledger by {pivot.granularity === "week" ? "week" : "month"}, {pivot.periods.length} periods
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 top-0 z-30 min-w-[11rem] border-b border-r border-neutral-200 bg-neutral-50 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-neutral-500"
            >
              {pivot.granularity === "week" ? "Week of" : "Month"}
            </th>
            {pivot.periods.map((period, index) => (
              <th
                key={period.key}
                scope="col"
                className={cn(
                  "sticky top-0 z-20 min-w-[6.5rem] border-b border-neutral-200 px-3 py-2 text-right text-[11px] font-medium uppercase tracking-wide text-neutral-500",
                  period.post_change ? "bg-canary-50" : "bg-neutral-50",
                )}
              >
                <PeriodHeader
                  pivot={pivot}
                  period={period}
                  isChangePoint={index === firstPostChange}
                />
              </th>
            ))}
            <th
              scope="col"
              className="sticky top-0 z-20 min-w-[7rem] border-b border-l border-neutral-200 bg-neutral-50 px-3 py-2 text-right text-[11px] font-medium uppercase tracking-wide text-neutral-500"
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help border-b border-dotted border-neutral-300">run-rate</span>
                </TooltipTrigger>
                <TooltipContent>
                  Annualized run-rate: the {pivot.weeks_of_history} weeks of history in this sheet,
                  extrapolated × 52 ÷ weeks. It is an extrapolation of what already happened, not a
                  forecast.
                </TooltipContent>
              </Tooltip>
            </th>
          </tr>
        </thead>

        <tbody>
          {visible.map((row) => {
            const children = childCount.get(row.id) ?? 0;
            const isSection = row.level === 0;
            const drillable = row.level === 2;

            return (
              <tr key={row.id} className={cn("group", row.id === focusRowId ? "bg-canary-50/60" : null)}>
                <th
                  scope="row"
                  className={cn(
                    "sticky left-0 z-10 border-b border-r border-neutral-100 px-3 py-1.5 text-left font-normal",
                    row.id === focusRowId ? "bg-canary-50" : "bg-white",
                    isSection ? "font-medium text-neutral-900" : "text-neutral-600",
                    row.section === "CASH_END" || row.section === "NET_BURN" ? "font-medium" : null,
                  )}
                >
                  <RowLabel
                    row={row}
                    hasChildren={children > 0}
                    collapsed={collapsed.has(row.id)}
                    onToggle={() => toggle(row.id)}
                  />
                </th>

                {row.cells.map((cell, index) => {
                  const period = pivot.periods[index];
                  if (!period) return null;
                  const text = isEmpty(cell) ? EMPTY : formatPivotAmount(row.section, cell.amount_cents);
                  const emphasis =
                    row.section === "CASH_END" || (isSection && row.section === "NET_BURN")
                      ? "font-semibold text-neutral-900"
                      : null;

                  return (
                    <td
                      key={period.key}
                      className={cn(
                        "border-b border-neutral-100 px-3 py-1.5 text-right tabular-nums",
                        period.post_change ? "bg-canary-50/40" : null,
                        isEmpty(cell) ? "text-neutral-300" : "text-neutral-700",
                        emphasis,
                      )}
                    >
                      {drillable && !isEmpty(cell) ? (
                        <button
                          type="button"
                          onClick={() => onCellSelect({ row, period, cell })}
                          className="rounded px-1 -mx-1 underline-offset-2 hover:bg-neutral-100 hover:underline"
                          aria-label={`${entityDisplayName(row.entity ?? row.label)} in ${periodLabel(pivot, period)}: ${text}`}
                        >
                          {text}
                          <CellFlags flags={cell.flags} />
                        </button>
                      ) : (
                        <>
                          {text}
                          <CellFlags flags={cell.flags} />
                        </>
                      )}
                    </td>
                  );
                })}

                <td
                  className={cn(
                    "border-b border-l border-neutral-100 px-3 py-1.5 text-right tabular-nums text-neutral-500",
                    row.section === "CASH_END" ? "text-neutral-300" : null,
                  )}
                >
                  {row.annualized_cents === null
                    ? EMPTY
                    : formatPivotAmount(row.section, row.annualized_cents)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PeriodHeader({
  pivot,
  period,
  isChangePoint,
}: {
  pivot: LedgerPivot;
  period: PivotPeriod;
  isChangePoint: boolean;
}) {
  const label = periodLabel(pivot, period);
  const range = `${formatDateMedium(period.start)} – ${formatDateMedium(period.end)}`;

  return (
    <span className="flex flex-col items-end gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help">{label}</span>
        </TooltipTrigger>
        <TooltipContent>
          {range}
          {period.partial ? " · partly outside the history window" : ""}
          {period.post_change ? " · after the confirmed change point" : ""}
        </TooltipContent>
      </Tooltip>
      {isChangePoint ? (
        <span className="text-[9px] font-semibold normal-case tracking-normal text-canary-700">
          change point
        </span>
      ) : null}
    </span>
  );
}

function RowLabel({
  row,
  hasChildren,
  collapsed,
  onToggle,
}: {
  row: PivotRow;
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  // Vendor keys are canonical (`aws`); the app owns their display spelling.
  const label = row.level === 2 && row.entity ? entityDisplayName(row.entity) : row.label;
  const indent = ["pl-0", "pl-4", "pl-8"][row.level] ?? "pl-0";

  return (
    <span className={cn("flex items-center gap-1.5", indent)}>
      {hasChildren ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
          className="-ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      ) : (
        <span className="w-4 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate">{label}</span>
      {row.incident_id ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={`/incidents/${row.incident_id}`}
              aria-label={`Open the incident driven by ${label}`}
              className="shrink-0 text-canary-600 hover:text-canary-700"
            >
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </Link>
          </TooltipTrigger>
          <TooltipContent>This vendor drives an open incident</TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}
