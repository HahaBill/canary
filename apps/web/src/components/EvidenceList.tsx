import { ExternalLink } from "lucide-react";
import { EVIDENCE_KINDS, type EvidenceItem, type EvidenceKind } from "@canary/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge.tsx";
import { formatTimestampMedium } from "@/lib/format.ts";

/** Blurbs are the taxonomy definitions from PRD §20, kept visible on purpose. */
export const KIND_META: Record<EvidenceKind, { label: string; blurb: string; variant: BadgeProps["variant"] }> = {
  OBSERVED: { label: "Observed", blurb: "Direct financial data", variant: "info" },
  DETECTED: { label: "Detected", blurb: "Canary detector output", variant: "accent" },
  EVIDENCE: { label: "Evidence", blurb: "External cited information", variant: "success" },
  ESTIMATE: { label: "Estimate", blurb: "Deterministic scenario calculation", variant: "neutral" },
  SUGGESTION: { label: "Suggestion", blurb: "AI-generated next step", variant: "quiet" },
};

/**
 * Evidence always renders in taxonomy order — observation, detection and
 * external research must never be mistaken for each other or for a suggestion.
 */
export function EvidenceList({ items }: { items: EvidenceItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-neutral-500">No evidence has been attached to this incident.</p>;
  }

  return (
    <div className="space-y-7">
      {EVIDENCE_KINDS.map((kind) => {
        const group = items.filter((item) => item.kind === kind);
        if (group.length === 0) return null;
        const meta = KIND_META[kind];

        return (
          <section key={kind} aria-labelledby={`evidence-${kind}`}>
            <div className="flex flex-wrap items-center gap-2">
              <h3
                id={`evidence-${kind}`}
                className="text-xs font-semibold uppercase tracking-wide text-neutral-900"
              >
                {meta.label}
              </h3>
              <Badge variant={meta.variant}>{meta.blurb}</Badge>
            </div>

            <ul className="mt-3 space-y-3">
              {group.map((item, index) => (
                <li
                  key={`${kind}-${index}`}
                  className="rounded-xl border border-neutral-200 bg-white p-4"
                >
                  <p className="text-sm leading-relaxed text-neutral-800">{item.text}</p>
                  {item.source_url ? (
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <a
                        href={item.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-medium text-neutral-900 underline-offset-4 hover:underline"
                      >
                        {item.source_title ?? item.source_url}
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </a>
                      {item.retrieved_at ? (
                        <span className="text-neutral-500">
                          retrieved {formatTimestampMedium(item.retrieved_at)}
                        </span>
                      ) : null}
                      {item.cached ? <Badge variant="quiet">previously retrieved</Badge> : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
