-- Additive only (docs/BUILD.md Rule 1): new nullable columns + indexes.
-- The Worker falls back to the 0001 column list if this migration has not run yet.

ALTER TABLE imessage_log ADD COLUMN command TEXT;
ALTER TABLE imessage_log ADD COLUMN provider_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_imessage_log_created_at ON imessage_log(created_at);
CREATE INDEX IF NOT EXISTS idx_imessage_log_phone ON imessage_log(phone);
CREATE INDEX IF NOT EXISTS idx_incidents_entity ON incidents(entity);
