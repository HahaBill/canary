-- Canary D1 schema (additive only — see docs/BUILD.md Rule 1).
-- The API workstream may ADD tables/columns in later numbered migrations; never drop/rename.

CREATE TABLE IF NOT EXISTS job_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  entity TEXT NOT NULL,
  status TEXT NOT NULL,
  estimated_change_point TEXT,
  first_detected TEXT NOT NULL,
  last_updated TEXT NOT NULL,
  last_notified TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);

CREATE TABLE IF NOT EXISTS vendor_enrichments (
  merchant_normalized TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  retrieved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classifications (
  transaction_id TEXT PRIMARY KEY,
  merchant_normalized TEXT NOT NULL,
  category TEXT NOT NULL,
  method TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imessage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  phone TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
