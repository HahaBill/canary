import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils.ts";

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-lg bg-neutral-200/70", className)} {...props} />;
}
