BEGIN;

ALTER TABLE site_inbox_messages
  ADD COLUMN IF NOT EXISTS recipient_user_id uuid REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS site_inbox_messages_recipient_published_idx
  ON site_inbox_messages(recipient_user_id, status, published_at DESC);

INSERT INTO schema_migrations(version)
VALUES ('0019_site_inbox_replies')
ON CONFLICT (version) DO NOTHING;

COMMIT;
