import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  applyLedgerFilter,
  describeLedgerFilter,
  isEmptyLedgerFilter,
  LEDGER_SEARCH_FAILED,
  LEDGER_SEARCH_UNMATCHED,
  type LedgerFilterInterpretation,
  type LedgerFilterSpec,
  type LedgerPivot,
  type PivotGranularity,
} from "@canary/shared";
import { Loader2, Sparkles, X } from "lucide-react";
import { queryLedgerFilter } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

const EXAMPLES = ["AWS after the change", "needs review", "cloud over $5k", "one-off in July"];
const INTERPRET_DEBOUNCE_MS = 250;

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
  const [source, setSource] = useState<LedgerFilterInterpretation["source"]>("empty");
  const [explanation, setExplanation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  function applyResult(result: LedgerFilterInterpretation) {
    setSpec(result.spec);
    setSource(result.source);
    setExplanation(result.explanation ?? null);
    onFiltered(applyLedgerFilter(pivot, result.spec), result.spec);
  }

  function applyEmpty() {
    const empty: LedgerFilterInterpretation = { spec: {}, chips: [], source: "empty", unmatched: false };
    applyResult(empty);
  }

  async function interpret(q: string) {
    const trimmed = q.trim();
    if (!trimmed) {
      setBusy(false);
      setError(null);
      setExplanation(null);
      applyEmpty();
      return;
    }

    const generation = ++generationRef.current;
    setBusy(true);
    setError(null);
    try {
      const result = await queryLedgerFilter(trimmed, granularity);
      if (generation !== generationRef.current) return;
      applyResult(result);
    } catch {
      if (generation !== generationRef.current) return;
      setError(LEDGER_SEARCH_FAILED);
      applyResult({
        spec: { unmatched: true, unmatched_reason: LEDGER_SEARCH_FAILED },
        chips: [],
        source: "unconfigured",
        unmatched: true,
        explanation: LEDGER_SEARCH_FAILED,
      });
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  }

  function schedule(q: string) {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void interpret(q);
    }, INTERPRET_DEBOUNCE_MS);
  }

  function runNow(q: string) {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void interpret(q);
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const q = draft.trim();
    if (!q) {
      applyEmpty();
      return;
    }
    runNow(q);
    // Re-interpret when the sheet (granularity) changes; the draft stays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pivot, granularity]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    runNow(draft);
  }

  function clear() {
    setDraft("");
    setError(null);
    setExplanation(null);
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    generationRef.current += 1;
    setBusy(false);
    applyEmpty();
  }

  const chips = describeLedgerFilter(spec, pivot);
  const active = !isEmptyLedgerFilter(spec);
  const emptySheet = active && applyLedgerFilter(pivot, spec).rows.length === 0;
  const emptyMessage = explanation ?? LEDGER_SEARCH_UNMATCHED;

  return (
    <div className="space-y-2" role="search">
      <form onSubmit={onSubmit} className="relative" aria-busy={busy}>
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
            if (!value.trim()) {
              if (debounceRef.current !== null) {
                window.clearTimeout(debounceRef.current);
                debounceRef.current = null;
              }
              generationRef.current += 1;
              setBusy(false);
              applyEmpty();
              return;
            }
            schedule(value);
          }}
          placeholder='Ask this sheet: "display all delivery services"'
          autoComplete="off"
          className={cn(
            "h-11 w-full rounded-2xl border border-neutral-200 bg-white py-2 pl-10 pr-24 text-sm text-neutral-900 shadow-sm",
            "placeholder:text-neutral-400 focus:border-canary-400 focus:outline-none focus:ring-2 focus:ring-canary-200",
          )}
        />
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {busy ? <Loader2 className="h-4 w-4 animate-spin text-neutral-400" aria-label="Interpreting filter" /> : null}
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
                runNow(example);
              }}
            >
              {example}
            </button>
          </span>
        ))}
      </p>

      {active && !spec.unmatched ? (
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
            <span className="text-[11px] text-neutral-400">interpreted by Canary</span>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="text-[11px] text-neutral-500">{error}</p> : null}

      {emptySheet ? (
        <p role="status" className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
          {emptyMessage} Try a vendor on this sheet, a month, or Needs Review.
        </p>
      ) : null}
    </div>
  );
}
