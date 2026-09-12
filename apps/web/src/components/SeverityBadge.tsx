import type { Severity } from "@canary/shared";
import { Badge } from "@/components/ui/badge.tsx";

/** Muted on purpose — the canary accent is the only loud color in the app. */
const SEVERITY: Record<Severity, { label: string; variant: "neutral" | "warn" | "danger" }> = {
  LOW: { label: "Low", variant: "neutral" },
  MEDIUM: { label: "Medium", variant: "warn" },
  HIGH: { label: "High", variant: "danger" },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const { label, variant } = SEVERITY[severity];
  return <Badge variant={variant}>{label} severity</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant="outline">{status.charAt(0) + status.slice(1).toLowerCase()}</Badge>;
}
