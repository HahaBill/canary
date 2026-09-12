import { cn } from "@/lib/utils.ts";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Two-or-three-way switch (Weekly · Monthly). A radio group rather than tabs:
 * it picks a parameter, it does not reveal a panel.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  /** Accessible name for the group; not rendered. */
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex items-center gap-1 rounded-xl bg-neutral-100 p-1", className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
              active
                ? "bg-white text-neutral-900 shadow-sm"
                : "text-neutral-600 hover:text-neutral-900",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
