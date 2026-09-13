import { AGENT_TOOL_NAMES, type AgentToolName, type AskCanaryResponse } from "@canary/shared";
import { getAskCanary } from "@/api/client.ts";
import { mockAskCanary } from "@/api/mock.ts";

export const CONVAI_SCRIPT_SRC = "https://unpkg.com/@elevenlabs/convai-widget-embed";
export const CONVAI_SCRIPT_ID = "elevenlabs-convai-embed";

export type AskCanaryClientTool = (params: Record<string, unknown>) => Promise<unknown>;

/** Same names as iMessage. The widget host calls these; they hit `/api/tools/*`. */
export function createAskCanaryClientTools(
  fetchImpl: typeof fetch = fetch,
): Record<AgentToolName, AskCanaryClientTool> {
  const tools = {} as Record<AgentToolName, AskCanaryClientTool>;
  for (const name of AGENT_TOOL_NAMES) {
    tools[name] = (params) => runAskCanaryClientTool(name, params, fetchImpl);
  }
  return tools;
}

export async function runAskCanaryClientTool(
  name: AgentToolName,
  params: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(`/api/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params ?? {}),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: "invalid_json", detail: text.slice(0, 200) };
  }
}

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
