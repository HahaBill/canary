import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { InfoTooltip } from "@/components/ui/tooltip.tsx";

export interface StatCardProps {
  label: string;
  /** Already formatted through the shared money helpers. */
  value: string;
  caption?: string;
  /** How the figure is derived. Prose only — never a number. */
  info?: string;
  children?: ReactNode;
}

export function StatCard({ label, value, caption, info, children }: StatCardProps) {
  return (
    <section
      aria-label={label}
      className="rounded-2xl border border-neutral-200/80 bg-white p-5 shadow-sm sm:p-6"
    >
      <div className="flex items-center gap-1.5">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</h2>
        {info ? (
          <InfoTooltip label={info}>
            <button
              type="button"
              aria-label={`How ${label} is calculated`}
              className="text-neutral-300 transition-colors hover:text-neutral-500"
            >
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </InfoTooltip>
        ) : null}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-neutral-900 sm:text-3xl">
        {value}
      </p>
      {caption ? <p className="mt-1.5 text-xs leading-relaxed text-neutral-500">{caption}</p> : null}
      {children}
    </section>
  );
}
