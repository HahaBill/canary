/**
 * A scripted OpenAI chat-completions endpoint.
 *
 * Tests inject this as the `fetchImpl` of the REAL `openAiClient`, so the
 * client's own request shaping and response parsing are exercised too — the
 * only thing faked is the network. Each entry in the script answers one call,
 * in order, and every request body is recorded so a test can assert what the
 * model was actually shown (conversation memory, the compacted summary, the
 * tool schemas).
 */
import type { FetchLike } from "../sendblue/client.ts";
import type { ChatMessage, ToolSchema } from "../conversation/openai.ts";

export interface ScriptedToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  id?: string;
}

export interface ScriptedTurn {
  /** Tools the model "decides" to call this round. */
  tool_calls?: ScriptedToolCall[];
  /** The assistant text. Omit when the turn is only tool calls. */
  content?: string;
  /** Non-2xx status, for the error-path tests. */
  status?: number;
  /** Raw response body, overriding the generated one. */
  raw?: string;
}

export interface CapturedLlmRequest {
  model: string;
  temperature: number;
  max_tokens: number;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  response_format?: { type: string };
}

export interface FakeOpenAi {
  fetchImpl: FetchLike;
  /** Request bodies in call order. */
  requests: CapturedLlmRequest[];
  /** Every `content` string the founder/system/tools put in front of the model, per request. */
  textOf(requestIndex: number): string;
}

export function fakeOpenAi(script: ScriptedTurn[]): FakeOpenAi {
  const requests: CapturedLlmRequest[] = [];
  let call = 0;

  const fetchImpl: FetchLike = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as CapturedLlmRequest);
    const turn = script[call++];

    // An exhausted script answers with an empty completion rather than hanging:
    // a test that runs off the end fails on the reply, not on a timeout.
    if (!turn) return json(200, { choices: [{ message: { role: "assistant", content: null } }] });
    if (turn.raw !== undefined) return new Response(turn.raw, { status: turn.status ?? 200, headers: { "content-type": "application/json" } });
    if (turn.status && turn.status >= 400) return json(turn.status, { error: { message: "scripted upstream failure" } });

    return json(200, {
      choices: [
        {
          message: {
            role: "assistant",
            content: turn.content ?? null,
            ...(turn.tool_calls && turn.tool_calls.length > 0
              ? {
                  tool_calls: turn.tool_calls.map((t, i) => ({
                    id: t.id ?? `call_${call}_${i}`,
                    type: "function",
                    function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) },
                  })),
                }
              : {}),
          },
        },
      ],
    });
  };

  return {
    fetchImpl,
    requests,
    textOf(requestIndex: number): string {
      return (requests[requestIndex]?.messages ?? []).map((m) => `${m.role}: ${m.content ?? ""}`).join("\n");
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
