import { useEffect, useState, type FormEvent } from "react";
import {
  applyLedgerFilter,
  describeLedgerFilter,
  isEmptyLedgerFilter,
  parseLedgerQuery,
  type LedgerFilterSpec,
  type LedgerPivot,
  type PivotGranularity,
} from "@canary/shared";
import { Loader2, Sparkles, X } from "lucide-react";
import { queryLedgerFilter } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

const EXAMPLES = ["AWS after the change", "needs review", "cloud over $5k", "one-off in July"];

export function LedgerSearch({
  pivot,
  granularity,
  onFiltered,
}: {
  pivot: LedgerPivot;
  granularity: PivotGranularity;
  onFiltered: (next: LedgerPivot, spec: LedgerFilterSpec) => void;
}) {
  const [draft, setDraft] = useState("");
  const [spec, setSpec] = useState<LedgerFilterSpec>({});
  const [source, setSource] = useState<"rules" | "model">("rules");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function apply(next: LedgerFilterSpec, nextSource: "rules" | "model" = "rules") {
    setSpec(next);
    setSource(nextSource);
    onFiltered(applyLedgerFilter(pivot, next), next);
  }

  useEffect(() => {
    apply(parseLedgerQuery(draft, pivot), "rules");
    // Re-run when the sheet (granularity) changes; the draft stays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pivot, granularity]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const q = draft.trim();
    if (!q) {
      apply({}, "rules");
      return;
    }
    apply(parseLedgerQuery(q, pivot), "rules");
    setBusy(true);
    setError(null);
    try {
      const result = await queryLedgerFilter(q, granularity);
      apply(result.spec, result.source);
    } catch {
      setError("Could not refine that with Canary — using the local filter.");
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    setDraft("");
    setError(null);
    apply({}, "rules");
  }

  const chips = describeLedgerFilter(spec, pivot);
  const active = !isEmptyLedgerFilter(spec);
  const emptySheet = active && applyLedgerFilter(pivot, spec).rows.length === 0;

  return (
    <div className="space-y-2" role="search">
      <form onSubmit={onSubmit} className="relative">
        <label htmlFor="ledger-filter" className="sr-only">
          Filter the ledger
        </label>
        <Sparkles className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-canary-600" aria-hidden="true" />
        <input
          id="ledger-filter"
          type="search"
          value={draft}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            setError(null);
            apply(parseLedgerQuery(value, pivot), "rules");
          }}
          placeholder='Filter this sheet: "AWS after the change"'
          autoComplete="off"
          className={cn(
            "h-11 w-full rounded-2xl border border-neutral-200 bg-white py-2 pl-10 pr-24 text-sm text-neutral-900 shadow-sm",
            "placeholder:text-neutral-400 focus:border-canary-400 focus:outline-none focus:ring-2 focus:ring-canary-200",
          )}
        />
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {busy ? <Loader2 className="h-4 w-4 animate-spin text-neutral-400" aria-label="Refining filter" /> : null}
          {draft ? (
            <Button type="button" variant="ghost" size="icon" onClick={clear} aria-label="Clear ledger filter">
              <X className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </form>

      <p className="text-[11px] text-neutral-400">
        {EXAMPLES.map((example, i) => (
          <span key={example}>
            {i > 0 ? <span aria-hidden="true"> · </span> : null}
            <button
              type="button"
              className="hover:text-neutral-600 hover:underline"
              onClick={() => {
                setDraft(example);
                apply(parseLedgerQuery(example, pivot), "rules");
              }}
            >
              {example}
            </button>
          </span>
        ))}
      </p>

      {active ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
          {chips.map((chip) => (
            <span
              key={chip}
              className="rounded-full bg-canary-50 px-2 py-0.5 text-[11px] font-medium text-canary-800 ring-1 ring-canary-200"
            >
              {chip}
            </span>
          ))}
          {source === "model" ? (
            <span className="text-[11px] text-neutral-400">refined by Canary</span>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="text-[11px] text-neutral-500">{error}</p> : null}

      {emptySheet ? (
        <p role="status" className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
          Nothing in this sheet matches that. Try a vendor, a month, or Needs Review.
        </p>
      ) : null}
    </div>
  );
}
