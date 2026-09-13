import { Link } from "react-router-dom";
import { useDerived } from "@/api/useDerived.ts";

export function AskCanaryPage() {
  const { data } = useDerived();
  const whatIfHref = data?.primary_incident
    ? `/incidents/${encodeURIComponent(data.primary_incident.id)}?tab=whatif`
    : "/incidents";

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">Ask Canary</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-neutral-500">
          Use <span className="font-medium text-neutral-800">Start a call</span> in the
          bottom-right corner once voice is connected. Same tools as iMessage. Spoken figures come
          from a tool result in this conversation; exact amounts stay on the incident page. Answers
          follow OBSERVED → DETECTED → EVIDENCE → ESTIMATE → SUGGESTION. Suggestions are never
          operational orders.
        </p>
        <p className="mt-2 text-sm text-neutral-600">
          Try asking: “What if AWS were 20% lower?” Or open the{" "}
          <Link to={whatIfHref} className="font-medium text-neutral-900 underline-offset-2 hover:underline">
            what-if simulator
          </Link>
          .
        </p>
      </header>
    </div>
  );
}
