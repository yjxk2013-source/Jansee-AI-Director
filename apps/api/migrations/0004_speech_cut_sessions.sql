BEGIN;

CREATE TABLE speech_cut_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'analyzing'
    CHECK (status IN ('analyzing', 'awaiting_confirmation', 'producing', 'consumed', 'failed', 'expired')),
  duration_sec numeric(10,3),
  transcript text NOT NULL DEFAULT '',
  words jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggestions jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_suggestion_ids jsonb,
  job_id uuid,
  error_message varchar(500),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (asset_id, user_id) REFERENCES assets(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES generation_jobs(id) ON DELETE SET NULL
);

CREATE INDEX speech_cut_sessions_owner_created_idx
  ON speech_cut_sessions(user_id, created_at DESC);
CREATE INDEX speech_cut_sessions_expiry_idx
  ON speech_cut_sessions(expires_at)
  WHERE status IN ('analyzing', 'awaiting_confirmation');

INSERT INTO schema_migrations(version)
VALUES ('0004_speech_cut_sessions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
