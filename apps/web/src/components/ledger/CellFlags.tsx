import type { PivotCell } from "@canary/shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

type Flag = PivotCell["flags"][number];

/**
 * Markers, not decorations: each one tells the reader why a number is treated
 * differently by the detectors, and none of them changes the number.
 */
const FLAGS: Record<Flag, { glyph: string; explanation: string; className: string }> = {
  one_off: {
    glyph: "•",
    explanation: "Contains a one-off payment — excluded from monitoring, still counted in burn.",
    className: "text-neutral-500",
  },
  needs_review: {
    glyph: "•",
    explanation: "Contains a transaction that could not be classified — Needs Review. The amount still counts.",
    className: "text-amber-500",
  },
  refund: {
    glyph: "↩",
    explanation: "A vendor refund is netted into this figure.",
    className: "text-neutral-500",
  },
  annual_renewal: {
    glyph: "↻",
    explanation: "Predictable annual renewal — excluded from monitoring, still counted in burn.",
    className: "text-neutral-500",
  },
  pending_dropped: {
    glyph: "◦",
    explanation: "A pending row was superseded by its settled twin and dropped, so nothing is double counted.",
    className: "text-neutral-400",
  },
};

export function CellFlags({ flags }: { flags: PivotCell["flags"] }) {
  if (flags.length === 0) return null;

  return (
    <span className="ml-1 inline-flex items-center gap-px align-super text-[9px] leading-none">
      {flags.map((flag) => {
        const spec = FLAGS[flag];
        if (!spec) return null;
        return (
          <Tooltip key={flag}>
            <TooltipTrigger asChild>
              <span className={cn("cursor-help", spec.className)} aria-label={spec.explanation}>
                {spec.glyph}
              </span>
            </TooltipTrigger>
            <TooltipContent>{spec.explanation}</TooltipContent>
          </Tooltip>
        );
      })}
    </span>
  );
}

/** Same vocabulary, spelled out under the sheet. */
export function FlagLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-500">
      {(Object.keys(FLAGS) as Flag[]).map((flag) => (
        <li key={flag} className="flex items-center gap-1.5">
          <span className={cn("text-[10px]", FLAGS[flag].className)}>{FLAGS[flag].glyph}</span>
          <span>{flag.replace(/_/g, " ")}</span>
        </li>
      ))}
    </ul>
  );
}
