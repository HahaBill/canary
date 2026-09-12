import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "@/lib/utils.ts";

export {
  Dialog as SideSheet,
  DialogTrigger as SideSheetTrigger,
  DialogClose as SideSheetClose,
} from "@/components/ui/dialog.tsx";
export {
  DialogBody as SideSheetBody,
  DialogDescription as SideSheetDescription,
  DialogHeader as SideSheetHeader,
  DialogTitle as SideSheetTitle,
} from "@/components/ui/dialog.tsx";

/**
 * A right-hand panel on desktop, the same bottom sheet a `Dialog` uses on
 * phones. Radix Dialog underneath, so focus trapping and Escape come free.
 */
export const SideSheetContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-neutral-900/30 backdrop-blur-sm" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-2xl bg-white shadow-xl focus-visible:outline-none",
        "sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-full sm:max-w-md sm:rounded-none sm:rounded-l-2xl",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        aria-label="Close"
        className="absolute right-4 top-4 rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SideSheetContent.displayName = "SideSheetContent";
