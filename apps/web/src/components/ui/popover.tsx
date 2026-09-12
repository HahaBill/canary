/**
 * Small anchored panel. Hand-rolled because this dependency set has no Radix
 * popover and one short form does not justify another package: Escape closes
 * it, a click outside closes it, and focus returns to the trigger.
 *
 * The panel is portalled and positioned `fixed` against the trigger's rect, so
 * a scrollable table cell cannot clip it.
 */
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils.ts";

interface Anchor {
  top: number;
  left: number;
}

export function Popover({
  trigger,
  children,
  width = 288,
  className,
  label,
}: {
  /** Rendered as the toggle; receives the aria wiring. */
  trigger: ReactElement<{
    onClick?: (event: React.MouseEvent) => void;
    "aria-expanded"?: boolean;
    "aria-controls"?: string;
  }>;
  /** `(close) => content`, so a submit handler can dismiss the panel. */
  children: (close: () => void) => ReactNode;
  /** Panel width in px; also decides how far left of the trigger it sits. */
  width?: number;
  className?: string;
  /** Accessible name for the panel. */
  label: string;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const panelId = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = anchor !== null;

  const close = useCallback(() => {
    setAnchor(null);
    // Without this the focus ring lands on <body> after a submit.
    triggerRef.current?.focus();
  }, []);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Right-aligned to the trigger, clamped into the viewport.
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    setAnchor({ top: rect.bottom + 4, left });
  }, [width]);

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => place();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setAnchor(null);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, close]);

  return (
    <>
      {cloneElement(trigger, {
        onClick: (event: React.MouseEvent) => {
          trigger.props.onClick?.(event);
          triggerRef.current = event.currentTarget as HTMLElement;
          if (open) setAnchor(null);
          else place();
        },
        "aria-expanded": open,
        "aria-controls": panelId,
      })}

      {anchor
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label={label}
              style={{ top: anchor.top, left: anchor.left, width }}
              className={cn(
                "fixed z-50 rounded-xl border border-neutral-200 bg-white p-3 shadow-lg",
                className,
              )}
            >
              {children(close)}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
