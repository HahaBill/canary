import { AlertCircle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";

interface State {
  error: Error | null;
}

/**
 * Last line of defence around the SPA. A render error in one panel would
 * otherwise blank the whole page, which looks identical to "Canary is down" —
 * so we say what broke and offer a reload.
 *
 * Matches `ErrorState`'s look rather than reusing it: the recovery here is a
 * page reload, not a refetch, and the stack belongs in a `<details>`.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No telemetry in this build; the console is the only place this can go.
    console.error("Canary UI crashed", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-10">
        <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50/60 p-6 text-center sm:p-10">
          <AlertCircle className="mx-auto h-6 w-6 text-rose-500" aria-hidden="true" />
          <h2 className="mt-3 text-base font-semibold text-neutral-900">Could not load this view</h2>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-neutral-600">
            Something in the interface failed to render. Your data is unaffected — nothing here writes to
            the ledger.
          </p>
          <Button variant="outline" className="mt-4" onClick={() => window.location.reload()}>
            Reload
          </Button>
          <details className="mx-auto mt-4 max-w-md text-left">
            <summary className="cursor-pointer text-xs font-medium text-neutral-500">Error detail</summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-white/70 p-3 text-[11px] leading-relaxed text-neutral-600">
              {error.message || String(error)}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
