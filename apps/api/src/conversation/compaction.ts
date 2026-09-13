/**
 * Rolling compaction of a long iMessage thread.
 *
 * A summary may record what the founder asked, which vendors and incidents came
 * up, what they acknowledged and what is still open. It may NOT record a figure.
 * docs/AGENT_BEHAVIOR.md §3: a number may not be carried from an earlier turn —
 * it is re-fetched from a tool on the turn that needs it. A summary that
 * remembered "$19,479/wk" would smuggle a stale figure past the number guard,
 * because the guard only checks THIS turn's tool results. So the prompt forbids
 * figures and `stripFigures` removes them anyway, before the row is written.
 *
 * Compaction runs AFTER a reply is stored, never before one is answered: the
 * founder should not wait on the model summarising last week's conversation.
 * Every failure is swallowed — the thread simply stays verbatim and still works.
 */
import type { ISODateTime } from "@canary/shared";
import type { D1Store } from "../data/d1.ts";
import { CONVERSATION } from "./config.ts";
import { estimatedTokens, loadThread, type ThreadTurn } from "./memory.ts";
import type { LlmClient } from "./openai.ts";

export interface CompactionDeps {
  store: D1Store | null;
  llm: LlmClient;
  now: () => ISODateTime;
}

export type CompactionOutcome =
  | { compacted: false; reason: "no_store" | "under_budget" | "nothing_to_compact" | "llm_unconfigured" | "llm_failed" }
  | { compacted: true; summary: string; covers_through_id: number; turns_compacted: number };

const SYSTEM_PROMPT = [
  "You compact a text-message thread between a founder and Canary, a startup cash-monitoring tool, into a short memory note.",
  "Record: what the founder asked about, which vendors and incidents came up, what they acknowledged or dismissed, and any question left open.",
  "HARD RULE: never include a dollar amount, a percentage, a month count, a date, or any other number. Figures are re-fetched from tools every turn and must never be carried forward. Refer to them as 'the weekly rate' or 'the runway figure' instead.",
  "Do not include URLs or internal ids. Do not add anything the thread does not say.",
  'Respond with JSON only: {"summary": "<at most four sentences>"}.',
].join("\n");

const NUMBER_WORD = "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half";
const SPELLED_FIGURE_RE = new RegExp(`\\b(?:about\\s+)?(?:${NUMBER_WORD})(?:[\\s-](?:and|a|${NUMBER_WORD}))*\\s+(?:percent(?:age)?|months?|weeks?|dollars?)\\b`, "gi");
const MONEY_RE = /[-+]?\$\s?\d[\d,]*(?:\.\d+)?\s?[KMB]?/g;
const DIGIT_RUN_RE = /\d[\d,.:/-]*\d|\d/g;
const ORPHAN_UNIT_RE = /(?:^|\s)(?:%|\$)(?=\s|$)/g;

/**
 * Removes every figure from a model-written summary — the backstop behind the
 * prompt rule. Digits go entirely (a date is a figure too), as do spelled-out
 * amounts like "about nineteen thousand dollars".
 */
export function stripFigures(text: string): string {
  return text
    .replace(MONEY_RE, "")
    .replace(SPELLED_FIGURE_RE, "")
    .replace(DIGIT_RUN_RE, "")
    .replace(/\s?%/g, "")
    .replace(/\$/g, "")
    .replace(ORPHAN_UNIT_RE, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([([])\s+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*\(\s*\)/g, "")
    .trim();
}

function transcript(turns: readonly ThreadTurn[]): string {
  return turns.map((turn) => `${turn.role === "founder" ? "Founder" : "Canary"}: ${turn.text}`).join("\n");
}

function parseSummary(content: string | null): string | null {
  if (!content) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    const summary = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["summary"] : null;
    return typeof summary === "string" && summary.trim().length > 0 ? summary.trim() : null;
  } catch {
    return null;
  }
}

/** True when the verbatim window is over either the turn count or the token budget. */
export function needsCompaction(turns: readonly ThreadTurn[]): boolean {
  return turns.length > CONVERSATION.MAX_TURNS || estimatedTokens(turns) > CONVERSATION.TOKEN_BUDGET;
}

/**
 * Folds everything older than the most recent `KEEP_RECENT` turns into the
 * rolling summary. Call after storing a reply.
 */
export async function compactIfNeeded(deps: CompactionDeps, phone: string): Promise<CompactionOutcome> {
  const { store, llm } = deps;
  if (!store) return { compacted: false, reason: "no_store" };

  const thread = await loadThread(store, phone);
  if (!needsCompaction(thread.turns)) return { compacted: false, reason: "under_budget" };

  const toCompact = thread.turns.slice(0, Math.max(0, thread.turns.length - CONVERSATION.KEEP_RECENT));
  if (toCompact.length === 0) return { compacted: false, reason: "nothing_to_compact" };
  if (!llm.configured) return { compacted: false, reason: "llm_unconfigured" };

  let summary: string | null;
  try {
    const completion = await llm.complete({
      jsonMode: true,
      maxTokens: CONVERSATION.MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            thread.summary ? `Existing memory note:\n${thread.summary}\n` : "",
            "Thread to fold into it (oldest first):",
            transcript(toCompact),
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });
    summary = parseSummary(completion.content);
  } catch (err) {
    console.warn(JSON.stringify({ msg: "conversation_compaction_failed", error: err instanceof Error ? err.message : String(err) }));
    return { compacted: false, reason: "llm_failed" };
  }

  const stripped = summary ? stripFigures(summary) : "";
  if (stripped.length === 0) return { compacted: false, reason: "llm_failed" };

  const coversThroughId = toCompact[toCompact.length - 1]!.id;
  const turnsCompacted = thread.turns_compacted + toCompact.length;
  await store.saveConversationSummary({
    phone,
    summary: stripped,
    covers_through_id: coversThroughId,
    turns_compacted: turnsCompacted,
    updated_at: deps.now(),
  });

  return { compacted: true, summary: stripped, covers_through_id: coversThroughId, turns_compacted: turnsCompacted };
}
