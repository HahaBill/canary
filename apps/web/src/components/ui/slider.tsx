import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils.ts";

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value"> {
  value: number;
}

/**
 * Styled native range input — keeps touch dragging, keyboard arrows and
 * screen-reader semantics without another dependency. See `.canary-range`.
 */
export const Slider = forwardRef<HTMLInputElement, SliderProps>(({ className, ...props }, ref) => (
  <input ref={ref} type="range" className={cn("canary-range", className)} {...props} />
));
Slider.displayName = "Slider";
