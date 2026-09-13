/**
 * Bottom-right Ask Canary dock. When the Worker has minted a signed URL the
 * ElevenLabs ConvAI widget mounts immediately so “Start a call” is reachable
 * without a second launcher. The browser never sees ELEVENLABS_API_KEY.
 * Without an agent, a short explainer stays in the same corner.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { createAskCanaryClientTools, ensureConvaiScript, loadAskCanary } from "@/lib/ask-canary.ts";

const TICKET_REFRESH_MS = 10 * 60 * 1000;
const WIDGET_ID = "ask-canary-widget";

interface ConvaiCallDetail {
  config: { clientTools?: ReturnType<typeof createAskCanaryClientTools> };
}

export function AskCanaryOrb() {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function pull() {
      try {
        const body = await loadAskCanary();
        if (cancelled) return;
        setSignedUrl(body.configured ? body.signed_url : null);
      } catch {
        if (!cancelled) setSignedUrl(null);
      } finally {
        if (!cancelled) setReady(true);
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
    if (!signedUrl) return;
    const host = document.getElementById(WIDGET_ID);
    if (!host) return;

    const onCall = (event: Event) => {
      const detail = (event as CustomEvent<ConvaiCallDetail>).detail;
      if (detail?.config) detail.config.clientTools = createAskCanaryClientTools();
    };
    host.addEventListener("elevenlabs-convai:call", onCall);
    return () => {
      host.removeEventListener("elevenlabs-convai:call", onCall);
    };
  }, [signedUrl]);

  if (!ready) return null;

  return (
    <div className="ask-canary-dock" data-ready={signedUrl ? "voice" : "explain"}>
      {signedUrl ? (
        <elevenlabs-convai
          id={WIDGET_ID}
          signed-url={signedUrl}
          variant="compact"
          action-text="Ask Canary"
          start-call-text="Start a call"
          end-call-text="End conversation"
          listening-text="Listening…"
          speaking-text="Canary speaking"
          avatar-orb-color-1="#f5c518"
          avatar-orb-color-2="#fff4b8"
        />
      ) : (
        <div className="ask-canary-panel" role="status" aria-label="Ask Canary">
          <p className="text-sm font-semibold text-neutral-900">Ask Canary</p>
          <p className="mt-1 text-sm leading-relaxed text-neutral-600">
            Voice starts from this corner once an ElevenLabs agent is connected. Until then, try
            “What if AWS were 20% lower?” on the incident what-if tab.
          </p>
          <Link
            to="/ask"
            className="mt-3 inline-flex text-sm font-medium text-neutral-900 underline-offset-2 hover:underline"
          >
            How Ask Canary works
          </Link>
        </div>
      )}
    </div>
  );
}
