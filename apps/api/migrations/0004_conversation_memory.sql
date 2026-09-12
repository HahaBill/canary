-- Additive only (docs/BUILD.md Rule 1): one new nullable column + one new table.
--
-- imessage_log.tool_calls: the deterministic tools that produced a conversational
-- reply, as a JSON array of tool names (e.g. `["simulate_cost_change"]`). NULL on
-- every keyword reply and on every inbound message, which is also how the hourly
-- conversational rate limit tells the two paths apart. The Worker falls back to
-- the 0002 column list (and then the 0001 one) if this migration has not run yet.
ALTER TABLE imessage_log ADD COLUMN tool_calls TEXT;

-- conversation_summaries: the rolling, compacted memory of one phone's thread.
-- Turns with `id <= covers_through_id` are represented by `summary` and are no
-- longer replayed verbatim; anything newer is loaded from imessage_log as-is.
--
-- The summary records intents, entities, incidents referenced and open questions.
-- It carries NO figures: docs/AGENT_BEHAVIOR.md §3 forbids carrying a number from
-- an earlier turn, so every dollar amount, percentage and month count is stripped
-- before the row is written and re-fetched from a tool on the turn that needs it.
CREATE TABLE IF NOT EXISTS conversation_summaries (
  phone TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  covers_through_id INTEGER NOT NULL,
  turns_compacted INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
