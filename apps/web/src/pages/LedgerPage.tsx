import { useMemo, useState } from "react";
import { isEmptyLedgerFilter, type LedgerFilterSpec, type LedgerPivot, type PivotGranularity } from "@canary/shared";
import { Download } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useLedger } from "@/api/useDerived.ts";
import { FlagLegend } from "@/components/ledger/CellFlags.tsx";
import { LedgerCellSheet } from "@/components/ledger/LedgerCellSheet.tsx";
import { LedgerSearch } from "@/components/ledger/LedgerSearch.tsx";
import { LedgerTable, periodLabel, type CellCoordinates } from "@/components/ledger/LedgerTable.tsx";
import { buildLedgerCsv, downloadCsv, ledgerCsvFilename } from "@/components/ledger/csv.ts";
import { ErrorState, PanelSkeleton } from "@/components/States.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Segmented } from "@/components/ui/segmented.tsx";
import { formatDateMedium } from "@/lib/format.ts";

const GRANULARITIES = [
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
] as const satisfies readonly { value: PivotGranularity; label: string }[];

export function LedgerPage() {
  // Monthly reads like a finance summary; weekly is the unit the detectors use.
  const [granularity, setGranularity] = useState<PivotGranularity>("month");
  const [selected, setSelected] = useState<CellCoordinates | null>(null);
  const [filter, setFilter] = useState<{ spec: LedgerFilterSpec; view: LedgerPivot } | null>(null);
  const { data: pivot, loading, error, reload } = useLedger(granularity);
  // Deep link from the cash calendar: `/ledger?focus=vendor:aws`.
  const [searchParams] = useSearchParams();
  const focusRowId = searchParams.get("focus") ?? undefined;
  const sheet = pivot && filter?.view && filter.view.granularity === pivot.granularity ? filter.view : pivot;
  const revealRowIds = useMemo(() => {
    if (!sheet || !filter || isEmptyLedgerFilter(filter.spec)) return undefined;
    return sheet.rows.filter((row) => row.level === 2).map((row) => row.id);
  }, [sheet, filter]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">Ledger</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {pivot
              ? `${formatDateMedium(pivot.history_start)} – ${formatDateMedium(pivot.history_end)} · ${pivot.weeks_of_history} weeks`
              : "Reconciled spend by period"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Segmented
            label="Ledger granularity"
            value={granularity}
            options={GRANULARITIES}
            onChange={setGranularity}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!pivot}
            onClick={() => {
              if (sheet) downloadCsv(ledgerCsvFilename(sheet), buildLedgerCsv(sheet));
            }}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            CSV
          </Button>
        </div>
      </header>

      {error ? <ErrorState message={error} onRetry={reload} /> : null}

      {!error && (loading || !pivot) ? <PanelSkeleton className="h-96" /> : null}

      {!error && pivot && sheet ? (
        <>
          <LedgerSearch
            pivot={pivot}
            granularity={granularity}
            onFiltered={(view, spec) => setFilter({ view, spec })}
          />
          <LedgerTable pivot={sheet} focusRowId={focusRowId} revealRowIds={revealRowIds} onCellSelect={setSelected} />

          <div className="space-y-2">
            <FlagLegend />
            <p className="text-[11px] leading-relaxed text-neutral-400">
              Every figure is reconciled engine output: pending rows superseded by their settled twin
              are dropped, internal transfers and card settlements net to zero, vendor refunds are
              netted, and financing sits outside operating burn. One-off payments still count in
              cash and burn but are excluded from the change detector.
              {pivot.regime_start
                ? ` Tinted periods are at or after the confirmed change point, the week of ${formatDateMedium(pivot.regime_start)}.`
                : ""}{" "}
              Click any vendor figure to see the transactions behind it.
            </p>
          </div>

          <LedgerCellSheet
            coordinates={selected}
            granularity={granularity}
            periodLabel={selected ? periodLabel(sheet, selected.period) : ""}
            onClose={() => setSelected(null)}
          />
        </>
      ) : null}
    </div>
  );
}
