-- Additive only (docs/BUILD.md Rule 1): two new tables, nothing dropped or renamed.
--
-- google_oauth: the founder's Google Calendar connection. Exactly one row,
-- `id = 'founder'` — Canary has no per-user auth, and a second row would mean a
-- second account nobody asked for.
--
-- Both tokens are AES-GCM ciphertext (base64 of iv ‖ ciphertext), encrypted with
-- a key derived from WEBHOOK_SECRET before they ever reach D1, so a database
-- dump or a shared `wrangler d1 execute` shows nothing usable. Rotating
-- WEBHOOK_SECRET therefore invalidates the connection — the operator reconnects,
-- which is the correct outcome for a secret that has leaked.
--
-- `revoked_at` is set when Google answers a refresh with `invalid_grant` (the
-- founder revoked access, or a Testing-mode consent expired). The row is kept so
-- `/api/calendar/connection` can say "reconnect" rather than "never connected",
-- and the app falls back to the ICS feed instead of retrying a dead token.
CREATE TABLE IF NOT EXISTS google_oauth (
  id TEXT PRIMARY KEY,
  refresh_token_encrypted TEXT NOT NULL,
  access_token_encrypted TEXT,
  expires_at TEXT,
  scope TEXT,
  account_email TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

-- review_events: a review Canary booked on the founder's calendar. The event
-- itself lives in Google; this is Canary's own record, which is what lets
-- `/api/calendar` draw the `canary` marker without a Google round trip (or after
-- the connection is gone). `id` is incident_id + start, so re-booking the same
-- slot upserts instead of duplicating the marker.
CREATE TABLE IF NOT EXISTS review_events (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  html_link TEXT,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_events_start ON review_events(start_at);
CREATE INDEX IF NOT EXISTS idx_review_events_incident ON review_events(incident_id);
