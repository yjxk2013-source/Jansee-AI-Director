BEGIN;

CREATE TABLE IF NOT EXISTS tts_voice_health (
  voice_type integer PRIMARY KEY CHECK (voice_type > 0),
  gender text NOT NULL CHECK (gender IN ('male', 'female')),
  language text NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('healthy', 'unavailable', 'unknown')),
  last_probe_status text NOT NULL DEFAULT 'unknown' CHECK (last_probe_status IN ('healthy', 'unavailable', 'unknown')),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code varchar(160),
  reason varchar(500),
  checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tts_voice_health_status_idx
  ON tts_voice_health(status, gender, voice_type);

CREATE TABLE IF NOT EXISTS tts_voice_probe_runs (
  id uuid PRIMARY KEY,
  trigger text NOT NULL CHECK (trigger IN ('startup', 'schedule', 'manual')),
  status text NOT NULL CHECK (status IN ('healthy', 'degraded', 'failed')),
  total_count integer NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  healthy_count integer NOT NULL DEFAULT 0 CHECK (healthy_count >= 0),
  unavailable_count integer NOT NULL DEFAULT 0 CHECK (unavailable_count >= 0),
  unknown_count integer NOT NULL DEFAULT 0 CHECK (unknown_count >= 0),
  details jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS tts_voice_probe_runs_completed_idx
  ON tts_voice_probe_runs(completed_at DESC);

INSERT INTO schema_migrations(version)
VALUES ('0022_tts_voice_health')
ON CONFLICT (version) DO NOTHING;

COMMIT;
