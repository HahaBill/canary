import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-rose-200 bg-rose-50/60 p-6 text-center sm:p-10"
    >
      <AlertCircle className="mx-auto h-6 w-6 text-rose-500" aria-hidden="true" />
      <h2 className="mt-3 text-base font-semibold text-neutral-900">Could not load this view</h2>
      <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-neutral-600">{message}</p>
      {onRetry ? (
        <Button variant="outline" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function StatRowSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-32 rounded-2xl" />
      ))}
    </div>
  );
}

export function PanelSkeleton({ className = "h-64" }: { className?: string }) {
  return <Skeleton className={`${className} rounded-2xl`} />;
}
