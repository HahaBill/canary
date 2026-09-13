/**
 * Always-on "Ask a question" launcher in the bottom-right. The ElevenLabs
 * talk UI starts from this button when the Worker has minted a signed URL;
 * otherwise the button still opens a short explainer so the control is never
 * invisible.
 */
import { useEffect, useState } from "react";
import { Bird } from "lucide-react";
import { Link } from "react-router-dom";
import { createAskCanaryClientTools, ensureConvaiScript, loadAskCanary } from "@/lib/ask-canary.ts";

const TICKET_REFRESH_MS = 10 * 60 * 1000;
const WIDGET_ID = "ask-canary-widget";

interface ConvaiHost extends HTMLElement {
  startConversation?: () => void;
}

interface ConvaiCallDetail {
  config: { clientTools?: ReturnType<typeof createAskCanaryClientTools> };
}

export function AskCanaryOrb() {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [talking, setTalking] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function pull() {
      try {
        const body = await loadAskCanary();
        if (cancelled) return;
        setSignedUrl(body.configured ? body.signed_url : null);
      } catch {
        if (!cancelled) setSignedUrl(null);
      }
    }

    void pull();
    const timer = window.setInterval(() => void pull(), TICKET_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (signedUrl) ensureConvaiScript();
  }, [signedUrl]);

  useEffect(() => {
    if (!talking || !signedUrl) return;
    const host = document.getElementById(WIDGET_ID) as ConvaiHost | null;
    if (!host) return;

    const onCall = (event: Event) => {
      const detail = (event as CustomEvent<ConvaiCallDetail>).detail;
      if (detail?.config) detail.config.clientTools = createAskCanaryClientTools();
    };
    host.addEventListener("elevenlabs-convai:call", onCall);

    const start = () => host.startConversation?.();
    start();
    const retry = window.setTimeout(start, 400);
    return () => {
      host.removeEventListener("elevenlabs-convai:call", onCall);
      window.clearTimeout(retry);
    };
  }, [talking, signedUrl]);

  function onAsk() {
    if (signedUrl) {
      setPanelOpen(false);
      setTalking(true);
      return;
    }
    setPanelOpen((open) => !open);
  }

  return (
    <div className="ask-canary-dock">
      {panelOpen && !signedUrl ? (
        <div className="ask-canary-panel" role="dialog" aria-label="Ask Canary">
          <p className="text-sm font-semibold text-neutral-900">Ask Canary a question</p>
          <p className="mt-1 text-sm leading-relaxed text-neutral-600">
            Try “What if AWS were 20% lower?” Voice starts from this button once an ElevenLabs
            agent is connected.
          </p>
          <Link
            to="/ask"
            className="mt-3 inline-flex text-sm font-medium text-neutral-900 underline-offset-2 hover:underline"
            onClick={() => setPanelOpen(false)}
          >
            How Ask Canary works
          </Link>
        </div>
      ) : null}

      {talking && signedUrl ? (
        <elevenlabs-convai
          id={WIDGET_ID}
          signed-url={signedUrl}
          variant="compact"
          action-text="Ask Canary"
          start-call-text="Start talking"
          end-call-text="End conversation"
          listening-text="Listening…"
          speaking-text="Canary speaking"
          avatar-orb-color-1="#f5c518"
          avatar-orb-color-2="#fff4b8"
        />
      ) : null}

      <button
        type="button"
        className="ask-canary-launch"
        aria-label="Ask Canary a question"
        aria-expanded={panelOpen || talking}
        data-ready={signedUrl ? "voice" : "explain"}
        onClick={onAsk}
      >
        <span className="ask-canary-launch-label">Ask a question</span>
        <span className="ask-canary-launch-orb" aria-hidden="true">
          <Bird className="h-7 w-7" />
        </span>
      </button>
    </div>
  );
}
