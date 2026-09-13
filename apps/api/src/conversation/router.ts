/**
 * Conversational iMessage: the path an inbound message takes when it is NOT a
 * keyword command.
 *
 * The keyword path (WHY / SHOW ME / SOURCES / HELP) is untouched and still
 * matched first — it is the demo's guaranteed path and does not involve a model
 * at all. Everything else lands here: OpenAI chooses among Canary's
 * deterministic tools, the tools produce every figure, and the reply is checked
 * against them before it is sent.
 *
 * Order of defence, strongest last:
 *   1. a regex pre-filter that refuses money movement without calling a model;
 *   2. the system prompt (docs/AGENT_BEHAVIOR.md restated for the model);
 *   3. an explicit `refuse` tool, so a refusal is a decision we can test;
 *   4. `guard.ts`, which throws the whole reply away if a figure is not backed.
 */
import type { DerivedDemoObject, ISODateTime } from "@canary/shared";
import { primaryIncident } from "../derive.ts";
import type { DataProvider } from "../data/provider.ts";
import { healthLineMessage, helpMessage, refusalMessage, whyMessage, type RefusalKind } from "../messages.ts";
import { CONVERSATION } from "./config.ts";
import { checkFigures, stripUnknownUrls } from "./guard.ts";
import type { Thread } from "./memory.ts";
import type { ChatMessage, ChatToolCall, LlmClient } from "./openai.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { isOffTopic } from "./scope.ts";
import { isToolName, runTool, TOOL_SCHEMAS, type ToolResult } from "./tools.ts";

/** Prefixed to HELP when there is no model configured, so the founder knows why. */
export const UNCONFIGURED_PREFIX = "I can answer questions about spending, incidents and runway once my language model is configured.";

export interface ConversationRequest {
  text: string;
  /** Only ever used masked, to name a thread in logs — never sent to the model. */
  phone: string;
  thread: Thread;
  provider: DataProvider;
  baseUrl: string;
  llm: LlmClient;
  now: ISODateTime;
}

/** Why a reply is not model prose. `unconfigured` / `llm_error` / `rate_limited` send the HELP text. */
export type ConversationFallback = "unconfigured" | "llm_error" | "rate_limited" | "number_guard" | "no_content";

export interface ConversationReply {
  reply: string;
  tool_calls: string[];
  refused?: boolean;
  /** Absent on a normal answer. */
  fallback?: ConversationFallback;
}

/** True when `reply` is the HELP text, so the caller can report it as the HELP command. */
export function isHelpFallback(fallback: ConversationFallback | undefined): boolean {
  return fallback === "unconfigured" || fallback === "llm_error" || fallback === "rate_limited";
}

/**
 * Money movement never reaches the model.
 *
 * Canary has no payment rail and never will, so an instruction to move cash has
 * nothing in it for a model to weigh — it is refused before a token is spent.
 * The filter looks for an IMPERATIVE addressed to Canary, which is why
 * "how much did we pay the contractors?" survives it and "pay the AWS bill" does
 * not. Vendor-management requests ("cancel Datadog", "downgrade the plan") are
 * deliberately NOT here: those are judgment calls, and routing them through the
 * model's `refuse` tool keeps the decision explicit and visible in `tool_calls`
 * rather than buried in a regex.
 */
const LEAD_IN_RE = /^\s*(?:hey\s+canary\b[,\s]*)?(?:please\s+|just\s+|go ahead and\s+|can you\s+|could you\s+|would you\s+|i need you to\s+|i want you to\s+)*/i;
/** Imperatives with no benign reading for a read-only cash monitor. */
const MONEY_VERB_RE = /^(?:pay|repay|prepay|wire|transfer|remit|reimburse|withdraw)\b/i;
/** Imperatives that are only about money when their object is. */
const QUALIFIED_VERB_RE =
  /^(?:send\s+(?:the\s+|a\s+|our\s+|them\s+|him\s+|her\s+)?(?:money|payment|funds|cash|invoice|bill|\$)|move\s+(?:the\s+|our\s+|my\s+)?(?:money|funds|cash)|stop\s+(?:the\s+|that\s+|our\s+)?(?:payment|transfer|wire|paying)|schedule\s+(?:a\s+|the\s+)?(?:payment|transfer|wire))\b/i;
/** Money movement stated anywhere in the sentence, not just up front. */
const MONEY_PHRASE_RE = /\b(?:pay (?:off|down)|wire (?:them |him |her |us )?(?:money|\$)|move (?:the |our |my )?money|stop (?:the |that )?payment|cancel (?:the|our|my|this) (?:payment|transfer|wire|invoice|bill|check|cheque|ach|charge))\b/i;

/** Deterministic refusal for the cases that must never be negotiated with a model. */
export function preFilterRefusal(text: string): RefusalKind | null {
  const imperative = text.replace(LEAD_IN_RE, "");
  const moved = MONEY_VERB_RE.test(imperative) || QUALIFIED_VERB_RE.test(imperative) || MONEY_PHRASE_RE.test(text);
  if (moved) return "MOVE_MONEY";
  return isOffTopic(text) ? "OFF_TOPIC" : null;
}

function isRefusalKind(value: string): value is RefusalKind {
  return value === "MOVE_MONEY" || value === "OPERATIONAL" || value === "ADVICE" || value === "PREDICTION" || value === "OFF_TOPIC";
}

function threadMessages(thread: Thread): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (thread.summary) {
    messages.push({
      role: "system",
      content: `Earlier in this thread (compacted memory — it deliberately contains no figures; re-fetch any number from a tool): ${thread.summary}`,
    });
  }
  // Prior off-topic founder turns stay out of the prompt so they cannot steer the answer.
  for (const turn of thread.turns) {
    if (turn.role === "founder" && isOffTopic(turn.text)) continue;
    messages.push({ role: turn.role === "founder" ? "user" : "assistant", content: turn.text });
  }
  return messages;
}

/** Keeps iMessage replies to a chat-sized shape. */
function trimToLines(text: string, max = CONVERSATION.MAX_REPLY_LINES): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.slice(0, max).join("\n");
}

/** The reply Canary sends when a generated one cannot be trusted. */
async function deterministicFallback(provider: DataProvider): Promise<string> {
  const derived: DerivedDemoObject = await provider.getDerived();
  const incident = primaryIncident(derived);
  return incident ? whyMessage(derived, incident) : healthLineMessage(derived);
}

export async function answerConversationally(req: ConversationRequest): Promise<ConversationReply> {
  const preFiltered = preFilterRefusal(req.text);
  if (preFiltered) return { reply: refusalMessage(preFiltered), tool_calls: [], refused: true };

  if (!req.llm.configured) {
    return { reply: `${UNCONFIGURED_PREFIX}\n${helpMessage()}`, tool_calls: [], fallback: "unconfigured" };
  }

  const derived = await req.provider.getDerived();
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt({ derived, now: req.now }) },
    ...threadMessages(req.thread),
    { role: "user", content: req.text },
  ];

  const toolNames: string[] = [];
  const toolResults: ToolResult[] = [];
  const allowedUrls: string[] = [];
  const ctx = { provider: req.provider, baseUrl: req.baseUrl };

  let content: string | null = null;
  try {
    for (let round = 0; round < CONVERSATION.MAX_TOOL_ROUNDS; round++) {
      const completion = await req.llm.complete({ messages, tools: TOOL_SCHEMAS, maxTokens: CONVERSATION.MAX_TOKENS });
      if (completion.tool_calls.length === 0) {
        content = completion.content;
        break;
      }

      messages.push({ role: "assistant", content: completion.content ?? null, tool_calls: completion.tool_calls });

      for (const call of completion.tool_calls) {
        const name = call.function.name;
        if (isToolName(name)) toolNames.push(name);

        const outcome = await runTool(ctx, name, parseArguments(call));
        if (outcome.refusal) {
          const kind = isRefusalKind(outcome.refusal.reason) ? outcome.refusal.reason : "ADVICE";
          return { reply: refusalMessage(kind), tool_calls: toolNames, refused: true };
        }
        toolResults.push(outcome.result);
        allowedUrls.push(...outcome.urls);
        messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(outcome.result) });
      }
      // Last round used up on tools: ask once more, without them, for the prose.
      if (round === CONVERSATION.MAX_TOOL_ROUNDS - 1) {
        const final = await req.llm.complete({ messages, maxTokens: CONVERSATION.MAX_TOKENS });
        content = final.content;
      }
    }
  } catch (err) {
    console.warn(JSON.stringify({ msg: "conversation_llm_failed", error: err instanceof Error ? err.message : String(err) }));
    return { reply: helpMessage(), tool_calls: toolNames, fallback: "llm_error" };
  }

  const draft = trimToLines(stripUnknownUrls(content ?? "", allowedUrls));
  if (draft.length === 0) {
    return { reply: await deterministicFallback(req.provider), tool_calls: toolNames, fallback: "no_content" };
  }

  const figures = checkFigures(draft, toolResults);
  if (!figures.ok) {
    console.warn(
      JSON.stringify({ msg: "conversation_number_guard_replaced", thread: maskPhone(req.phone), offending: figures.offending, tools: toolNames }),
    );
    return { reply: await deterministicFallback(req.provider), tool_calls: toolNames, fallback: "number_guard" };
  }

  return { reply: draft, tool_calls: toolNames };
}

/** Enough to tell two threads apart in a log line, not enough to be a phone number. */
function maskPhone(phone: string): string {
  return `…${phone.replace(/\D/g, "").slice(-4)}`;
}

function parseArguments(call: ChatToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
