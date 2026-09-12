import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils.ts";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        neutral: "bg-neutral-100 text-neutral-700",
        quiet: "bg-neutral-50 text-neutral-500",
        outline: "border border-neutral-200 text-neutral-600",
        accent: "bg-canary-100 text-canary-800",
        info: "bg-sky-50 text-sky-700",
        warn: "bg-amber-50 text-amber-700",
        danger: "bg-rose-50 text-rose-700",
        success: "bg-emerald-50 text-emerald-700",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(({ className, variant, ...props }, ref) => (
  <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
));
Badge.displayName = "Badge";

export { badgeVariants };
