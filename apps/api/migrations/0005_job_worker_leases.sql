BEGIN;

ALTER TABLE generation_jobs
  ADD COLUMN IF NOT EXISTS worker_id varchar(120),
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);

CREATE INDEX IF NOT EXISTS generation_jobs_expired_lease_idx
  ON generation_jobs(lease_expires_at, queued_at)
  WHERE status IN ('inspecting', 'planning', 'rendering', 'quality-check')
    AND lease_expires_at IS NOT NULL;

INSERT INTO schema_migrations(version)
VALUES ('0005_job_worker_leases')
ON CONFLICT (version) DO NOTHING;

COMMIT;
