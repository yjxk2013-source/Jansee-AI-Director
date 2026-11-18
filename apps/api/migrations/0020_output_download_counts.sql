BEGIN;

ALTER TABLE generated_outputs
  ADD COLUMN IF NOT EXISTS download_count integer NOT NULL DEFAULT 0;

INSERT INTO schema_migrations(version)
VALUES ('0020_output_download_counts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
