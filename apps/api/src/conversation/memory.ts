/**
 * Per-phone conversation memory, read out of `imessage_log`.
 *
 * A thread is a rolling summary of everything already compacted plus the turns
 * newer than it, verbatim. Inbound rows are the founder, outbound rows are
 * Canary. Nothing here stores a separate copy of the conversation: the audit log
 * IS the memory, which means a reply the founder received is a reply Canary
 * remembers, and nothing else is.
 */
import type { ISODateTime } from "@canary/shared";
import { VOICE_LOG_PREFIX, type D1Store, type StoredMessage } from "../data/d1.ts";
import { CONVERSATION } from "./config.ts";

export interface ThreadTurn {
  /** `imessage_log.id` — what `covers_through_id` pages on. */
  id: number;
  role: "founder" | "canary";
  text: string;
  created_at: ISODateTime;
  /** Tools behind a Canary reply, when it came from the conversational path. */
  tool_calls?: string[];
}

export interface Thread {
  /** Rolling compacted memory of older turns, or null when nothing is compacted yet. */
  summary: string | null;
  /** Turns newer than the summary, oldest first. */
  turns: ThreadTurn[];
  /** Highest log id the summary accounts for; 0 when there is no summary. */
  covers_through_id: number;
  turns_compacted: number;
}

export const EMPTY_THREAD: Thread = { summary: null, turns: [], covers_through_id: 0, turns_compacted: 0 };

/** Rows that are transport artefacts rather than things anyone said. */
function isSpeech(row: StoredMessage): boolean {
  return row.body.trim().length > 0 && !row.body.startsWith(VOICE_LOG_PREFIX) && !row.body.startsWith("[ignored:");
}

export function toTurn(row: StoredMessage): ThreadTurn {
  return {
    id: row.id,
    role: row.direction === "inbound" ? "founder" : "canary",
    text: row.body,
    created_at: row.created_at,
    ...(row.tool_calls && row.tool_calls.length > 0 ? { tool_calls: row.tool_calls } : {}),
  };
}

/**
 * The thread for one phone: the compacted summary, plus every turn after it
 * (newest `limit`), oldest first.
 */
export async function loadThread(store: D1Store | null, phone: string, limit = CONVERSATION.HISTORY_FETCH_LIMIT): Promise<Thread> {
  if (!store) return EMPTY_THREAD;

  const compacted = await store.getConversationSummary(phone);
  const coversThroughId = compacted?.covers_through_id ?? 0;

  const rows = await store.listMessagesForPhone(phone, limit);
  const turns = rows
    .filter((row) => row.id > coversThroughId && isSpeech(row))
    .map(toTurn)
    .sort((a, b) => a.id - b.id);

  return {
    summary: compacted?.summary ?? null,
    turns,
    covers_through_id: coversThroughId,
    turns_compacted: compacted?.turns_compacted ?? 0,
  };
}

/** Cheap proxy for prompt size — no tokenizer in the Worker bundle. */
export function estimatedTokens(turns: readonly ThreadTurn[]): number {
  const chars = turns.reduce((sum, turn) => sum + turn.text.length, 0);
  return Math.ceil(chars / CONVERSATION.CHARS_PER_TOKEN);
}

/** Conversational replies sent to this phone since `since`. Backs the hourly cap. */
export async function countRecentConversationalReplies(store: D1Store | null, phone: string, since: ISODateTime): Promise<number> {
  if (!store) return 0;
  const rows = await store.listMessagesForPhone(phone, CONVERSATION.HISTORY_FETCH_LIMIT);
  return rows.filter((row) => row.direction === "outbound" && row.tool_calls !== null && row.created_at >= since).length;
}
