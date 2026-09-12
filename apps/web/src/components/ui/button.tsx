import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils.ts";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-neutral-900 text-white hover:bg-neutral-800",
        accent: "bg-canary-400 text-neutral-900 hover:bg-canary-300",
        outline: "border border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-50",
        ghost: "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
        link: "text-neutral-900 underline-offset-4 hover:underline",
      },
      size: {
        // `pointer-coarse:` lifts the compact sizes to a 44 px tap target on
        // touch devices; `min-height` wins over `height`, so desktop density is
        // untouched. (WCAG 2.5.8 / Apple HIG.)
        sm: "h-8 px-3 text-xs pointer-coarse:min-h-11",
        md: "h-10 px-4 pointer-coarse:min-h-11",
        lg: "h-11 px-5 text-base",
        icon: "h-9 w-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render the child element instead of a `<button>` (e.g. a router `<Link>`). */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = "Button";

export { buttonVariants };
