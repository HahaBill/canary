/**
 * ElevenLabs (and other hosts) wrap tool arguments in several shapes.
 * Unwrap them to the same `{ entity, id, … }` object `runTool` already
 * understands, so Ask Canary and iMessage cannot disagree about a figure.
 */
const WRAPPER_KEYS = new Set(["parameters", "arguments", "tool_params", "params", "tool_call"]);
const META_KEYS = new Set([
  "agent_id",
  "conversation_id",
  "tool_call_id",
  "tool_name",
  "type",
  "system__conversation_id",
]);

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (isPlain(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isPlain(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function collectLayers(input: Record<string, unknown>): Record<string, unknown>[] {
  const layers: Record<string, unknown>[] = [input];
  for (const key of ["parameters", "arguments", "tool_params", "params"]) {
    const nested = parseObject(input[key]);
    if (nested) layers.push(nested);
  }
  const toolCall = parseObject(input.tool_call);
  if (toolCall) {
    layers.push(toolCall);
    for (const key of ["parameters", "arguments"]) {
      const nested = parseObject(toolCall[key]);
      if (nested) layers.push(nested);
    }
  }
  return layers;
}

/** Flatten host wrappers and map spoken aliases (`vendor` → `entity`). */
export function unwrapToolArgs(input: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const layer of collectLayers(input)) {
    for (const [key, value] of Object.entries(layer)) {
      if (WRAPPER_KEYS.has(key) || META_KEYS.has(key)) continue;
      merged[key] = value;
    }
  }

  if (merged.id == null && merged.incident_id != null) merged.id = merged.incident_id;
  if (merged.incident_id == null && merged.id != null) merged.incident_id = merged.id;
  if (merged.entity == null && merged.vendor != null) merged.entity = merged.vendor;
  if (merged.percentage == null && merged.percent != null) merged.percentage = merged.percent;
  return merged;
}
