/**
 * Page-local confirmation. Deliberately not a context provider: only the
 * review queue needs it, and a provider would mean touching the app root.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils.ts";

export interface ToastMessage {
  id: number;
  text: string;
  tone: "success" | "error";
}

export function useToast(autoDismissMs = 5000) {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextId = useRef(0);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setToast(null);
  }, []);

  const show = useCallback(
    (text: string, tone: ToastMessage["tone"] = "success") => {
      if (timer.current) clearTimeout(timer.current);
      setToast({ id: nextId.current++, text, tone });
      timer.current = setTimeout(() => setToast(null), autoDismissMs);
    },
    [autoDismissMs],
  );

  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), []);

  return { toast, show, dismiss };
}

export function Toaster({ toast, onDismiss }: { toast: ToastMessage | null; onDismiss: () => void }) {
  return (
    // Always mounted so assistive tech announces the message when it arrives.
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 sm:bottom-6">
      {toast ? (
        <div
          className={cn(
            "pointer-events-auto flex max-w-md items-start gap-2.5 rounded-xl px-4 py-3 text-sm shadow-lg",
            toast.tone === "success" ? "bg-neutral-900 text-white" : "bg-rose-600 text-white",
          )}
        >
          {toast.tone === "success" ? (
            <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          ) : null}
          <p className="leading-relaxed">{toast.text}</p>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="-mr-1 mt-0.5 shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
