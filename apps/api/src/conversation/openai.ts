/**
 * OpenAI chat-completions client for the conversational iMessage path.
 *
 * Plain `fetch`, no SDK — the same house style as
 * `packages/classification/src/providers/openai.ts`, with tool calling added.
 * The model chooses tools and writes prose; it never computes money (PRD §21).
 * `fetchImpl` is injectable so every test runs offline against a scripted
 * transcript, and the real parsing code is exercised too.
 */
import type { FetchLike } from "../sendblue/client.ts";
import { CONVERSATION } from "./config.ts";

export const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
export const DEFAULT_MODEL = "gpt-4o-mini";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** An OpenAI function tool with a strict JSON schema. */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  /** JSON mode. Mutually exclusive with `tools` in practice — used by compaction. */
  jsonMode?: boolean;
  maxTokens?: number;
}

export interface ChatCompletion {
  content: string | null;
  tool_calls: ChatToolCall[];
}

/** The seam the router and compaction talk to. Tests inject a scripted implementation. */
export interface LlmClient {
  /** False when `OPENAI_API_KEY` is absent — callers fall back instead of pretending. */
  readonly configured: boolean;
  readonly model: string;
  complete(req: ChatRequest): Promise<ChatCompletion>;
}

/** The model refused, timed out, or returned something unusable. */
export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

export interface OpenAiClientOptions {
  apiKey?: string;
  model?: string;
  url?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export function openAiClient(options: OpenAiClientOptions = {}): LlmClient {
  const apiKey = options.apiKey?.trim() ?? "";
  const model = options.model?.trim() || DEFAULT_MODEL;
  const url = options.url ?? OPENAI_CHAT_COMPLETIONS_URL;
  const timeoutMs = options.timeoutMs ?? CONVERSATION.REQUEST_TIMEOUT_MS;

  return {
    configured: apiKey.length > 0,
    model,
    async complete(req: ChatRequest): Promise<ChatCompletion> {
      if (apiKey.length === 0) throw new LlmError("OPENAI_API_KEY is not configured");
      const doFetch = options.fetchImpl ?? ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => fetch(input, init));

      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: req.maxTokens ?? CONVERSATION.MAX_TOKENS,
            messages: req.messages,
            ...(req.tools && req.tools.length > 0 ? { tools: req.tools, tool_choice: "auto" } : {}),
            ...(req.jsonMode ? { response_format: { type: "json_object" } } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new LlmError(err instanceof Error ? err.message : String(err));
      }

      const raw = await res.text();
      if (!res.ok) throw new LlmError(`openai request failed with status ${res.status}: ${raw.slice(0, 200)}`);

      const message = firstMessage(raw);
      if (!message) throw new LlmError("openai returned no message");
      return message;
    },
  };
}

function firstMessage(raw: string): ChatCompletion | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const choices = asRecord(parsed)?.["choices"];
  const message = asRecord(Array.isArray(choices) ? choices[0] : null)?.["message"];
  const record = asRecord(message);
  if (!record) return null;

  const content = typeof record["content"] === "string" ? record["content"] : null;
  const rawCalls = record["tool_calls"];
  const tool_calls: ChatToolCall[] = Array.isArray(rawCalls)
    ? rawCalls.flatMap((call) => {
        const entry = asRecord(call);
        const fn = asRecord(entry?.["function"]);
        const name = typeof fn?.["name"] === "string" ? fn["name"] : null;
        if (!entry || !name) return [];
        return [
          {
            id: typeof entry["id"] === "string" ? entry["id"] : name,
            type: "function" as const,
            function: { name, arguments: typeof fn?.["arguments"] === "string" ? (fn["arguments"] as string) : "{}" },
          },
        ];
      })
    : [];

  return { content, tool_calls };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
