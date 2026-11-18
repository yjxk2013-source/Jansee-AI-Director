BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text,
  display_name varchar(80),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  user_agent varchar(500),
  ip_hash text,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_active_idx ON auth_sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title varchar(160) NOT NULL DEFAULT '新对话',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX conversations_user_updated_idx ON conversations(user_id, updated_at DESC);

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid,
  original_name varchar(255) NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('image', 'video')),
  mime_type varchar(120) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 209715200),
  sha256 char(64),
  storage_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'processing', 'ready', 'failed', 'expired', 'deleted')),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, user_id),
  FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id) ON DELETE CASCADE
);
CREATE INDEX assets_user_created_idx ON assets(user_id, created_at DESC);
CREATE INDEX assets_expiry_idx ON assets(expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  role text NOT NULL CHECK (role IN ('user', 'director', 'system')),
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sequence_no),
  FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id) ON DELETE CASCADE
);
CREATE INDEX conversation_messages_owner_idx ON conversation_messages(user_id, conversation_id, sequence_no);

CREATE TABLE generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid,
  mode text NOT NULL CHECK (mode IN ('image-film', 'video-dub', 'storyboard')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'inspecting', 'planning', 'rendering', 'quality-check', 'completed', 'failed', 'cancelled')),
  prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 2000),
  aspect_ratio text NOT NULL DEFAULT '9:16' CHECK (aspect_ratio IN ('9:16', '16:9', '1:1', '4:3')),
  idempotency_key uuid NOT NULL,
  request_payload jsonb NOT NULL,
  director_plan jsonb,
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error_code varchar(80),
  error_message varchar(500),
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  UNIQUE (id, user_id),
  FOREIGN KEY (conversation_id, user_id) REFERENCES conversations(id, user_id) ON DELETE CASCADE
);
CREATE INDEX generation_jobs_user_created_idx ON generation_jobs(user_id, created_at DESC);
CREATE INDEX generation_jobs_queue_idx ON generation_jobs(status, queued_at) WHERE status IN ('queued', 'inspecting', 'planning', 'rendering', 'quality-check');

CREATE TABLE generation_job_assets (
  job_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  user_id uuid NOT NULL,
  sequence_no smallint NOT NULL CHECK (sequence_no BETWEEN 1 AND 9),
  PRIMARY KEY (job_id, asset_id),
  UNIQUE (job_id, sequence_no),
  FOREIGN KEY (job_id, user_id) REFERENCES generation_jobs(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id, user_id) REFERENCES assets(id, user_id) ON DELETE RESTRICT
);

CREATE TABLE generated_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  user_id uuid NOT NULL,
  storage_key text NOT NULL UNIQUE,
  mime_type varchar(120) NOT NULL DEFAULT 'video/mp4',
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'expired', 'deleted')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY (job_id, user_id) REFERENCES generation_jobs(id, user_id) ON DELETE CASCADE
);
CREATE INDEX generated_outputs_user_created_idx ON generated_outputs(user_id, created_at DESC);
CREATE INDEX generated_outputs_expiry_idx ON generated_outputs(expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

INSERT INTO schema_migrations(version) VALUES ('0001_initial') ON CONFLICT (version) DO NOTHING;

COMMIT;
