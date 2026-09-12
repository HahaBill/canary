/**
 * Constants for the conversational iMessage path.
 *
 * CONTRACT GAP: these belong in `packages/shared/src/config.ts` next to every
 * other threshold (AGENTS.md rule 5 — shared is the contract). They live here
 * because `packages/shared` is frozen for this workstream. When it reopens, move
 * `CONVERSATION` verbatim and re-export it; nothing else in this directory needs
 * to change.
 */
export const CONVERSATION = {
  /** Verbatim turns above this trigger compaction on the NEXT reply, never this one. */
  MAX_TURNS: 12,
  /** Turns kept verbatim after compaction; everything older folds into the summary. */
  KEEP_RECENT: 6,
  /** Estimated prompt-token ceiling for verbatim turns (chars / CHARS_PER_TOKEN). */
  TOKEN_BUDGET: 3000,
  /** Rough chars-per-token used for the budget estimate. */
  CHARS_PER_TOKEN: 4,
  /** Tool rounds per reply before Canary answers with what it has. */
  MAX_TOOL_ROUNDS: 4,
  /** Conversational replies per phone per rolling hour; beyond this the founder gets HELP. */
  MAX_PER_HOUR: 30,
  /** Rows pulled per phone when loading a thread (verbatim window + slack for compaction). */
  HISTORY_FETCH_LIMIT: 60,
  /** iMessage is a chat window, not a report. */
  MAX_REPLY_LINES: 4,
  /** Per-OpenAI-request wall clock. Four rounds of this is the worst-case webhook latency. */
  REQUEST_TIMEOUT_MS: 15_000,
  MAX_TOKENS: 350,
} as const;
