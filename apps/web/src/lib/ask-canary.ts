import type { AskCanaryResponse } from "@canary/shared";
import { getAskCanary } from "@/api/client.ts";
import { mockAskCanary } from "@/api/mock.ts";

export const CONVAI_SCRIPT_SRC = "https://unpkg.com/@elevenlabs/convai-widget-embed";
export const CONVAI_SCRIPT_ID = "elevenlabs-convai-embed";

export function loadAskCanary(): Promise<AskCanaryResponse> {
  if (import.meta.env.DEV && import.meta.env.VITE_USE_MOCK === "1") {
    return Promise.resolve(mockAskCanary());
  }
  return getAskCanary();
}

export function ensureConvaiScript(): void {
  if (import.meta.env.MODE === "test") return;
  if (document.getElementById(CONVAI_SCRIPT_ID)) return;
  const script = document.createElement("script");
  script.id = CONVAI_SCRIPT_ID;
  script.src = CONVAI_SCRIPT_SRC;
  script.async = true;
  script.type = "text/javascript";
  document.body.appendChild(script);
}
