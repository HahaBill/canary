/**
 * `/api/tools/*` — the same `runTool` surface iMessage uses, exposed over HTTP
 * for Ask Canary / ElevenLabs. GET and POST both work (ElevenLabs defaults to
 * GET). Tool data errors are JSON 200s so the host does not treat them as a
 * failed call and then refuse to speak figures.
 */
import { AGENT_TOOL_NAMES, type AgentToolName } from "@canary/shared";
import { isToolName, runTool } from "../conversation/tools.ts";
import { baseUrl, jsonError, readJson, type CanaryApp, type CanaryContext } from "../context.ts";
import type { DataProvider } from "../data/provider.ts";
import { getHealthSummary, getIncidentTool } from "../tools.ts";
import { unwrapToolArgs } from "./tool-args.ts";

/** Names a voice prompt may still use; they dispatch to the real tools. */
const TOOL_ALIASES: Record<string, AgentToolName> = {
  get_runway: "get_health_summary",
  explain_incident: "get_incident",
};

export function registerToolRoutes(app: CanaryApp): void {
  const names = new Set<string>([...AGENT_TOOL_NAMES, ...Object.keys(TOOL_ALIASES)]);
  for (const name of names) {
    const path = `/api/tools/${name}`;
    const handler = (c: CanaryContext) => handleTool(c, name);
    app.get(path, handler);
    app.post(path, handler);
  }
}

async function handleTool(c: CanaryContext, requested: string): Promise<Response> {
  const raw = await readToolRequest(c);
  if (raw === null) return jsonError(c, 400, "invalid_json", "Request body must be a JSON object.");

  const name = TOOL_ALIASES[requested] ?? requested;
  if (!isToolName(name)) {
    return c.json({ error: "unknown_tool", detail: `${requested} is not a Canary tool.` });
  }

  const args = unwrapToolArgs(raw);
  const outcome = await runTool({ provider: c.get("provider"), baseUrl: baseUrl(c), llm: c.get("llm") }, name, args);
  const result = await withSpeech(c.get("provider"), name, outcome.result);
  return c.json(result);
}

async function readToolRequest(c: CanaryContext): Promise<Record<string, unknown> | null> {
  const query = c.req.query();
  if (c.req.method === "GET") return { ...query };
  const body = await readJson(c);
  if (body === null) return null;
  return { ...query, ...body };
}

/** Spoken strings for the voice path. iMessage still copies the formatted fields. */
async function withSpeech(
  provider: DataProvider,
  name: AgentToolName,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (name === "get_health_summary") {
    const summary = await getHealthSummary(provider);
    return { ...result, speech: summary.speech };
  }
  if (name === "get_incident" && typeof result.id === "string") {
    const detail = await getIncidentTool(provider, result.id);
    if (detail) return { ...result, speech: detail.speech };
  }
  return result;
}
