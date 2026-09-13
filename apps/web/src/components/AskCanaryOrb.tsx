/**
 * ElevenLabs floating talk orb. Lives on every page; the API key never
 * reaches the browser — only a short-lived signed conversation URL.
 */
import { useEffect, useState } from "react";
import { ensureConvaiScript, loadAskCanary } from "@/lib/ask-canary.ts";

/** Refresh before the ticket's 15-minute window runs out. */
const TICKET_REFRESH_MS = 10 * 60 * 1000;

export function AskCanaryOrb() {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);

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

  if (!signedUrl) return null;

  return (
    <elevenlabs-convai
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
  );
}
