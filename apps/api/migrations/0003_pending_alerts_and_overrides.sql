-- Additive only (docs/BUILD.md Rule 1): two new tables, nothing dropped or renamed.
--
-- pending_alerts: an alert the notification policy deferred because the founder
-- was in a meeting (docs/AGENT_BEHAVIOR.md §1 — Canary sends one message per
-- material incident, and not into the middle of a board meeting). The cron
-- trigger delivers it once they are free. `id` is derived deterministically from
-- incident_id + created_at so re-queueing the same alert is an upsert, never a
-- duplicate text. `to_phone` rather than `to`, which is a SQLite keyword.
CREATE TABLE IF NOT EXISTS pending_alerts (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  voice INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  deliver_after TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_alerts_undelivered ON pending_alerts(delivered_at, deliver_after);

-- classification_overrides: a human's decision about a Needs Review transaction.
-- The pipeline stays the source of truth for categories; this table records where
-- a reviewer overrode it, so the override survives a Worker restart and shows up
-- in `GET /api/needs-review`.
CREATE TABLE IF NOT EXISTS classification_overrides (
  transaction_id TEXT PRIMARY KEY,
  merchant_normalized TEXT NOT NULL,
  category TEXT NOT NULL,
  apply_to_merchant INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_classification_overrides_merchant ON classification_overrides(merchant_normalized);
