BEGIN;

-- 纯净宣发封面（无烧录台词、无 AI 角标）的对象存储键；nullable，旧作品没有该字段时前端回退到视频截帧。
ALTER TABLE generated_outputs
  ADD COLUMN IF NOT EXISTS cover_storage_key text;

INSERT INTO schema_migrations(version)
VALUES ('0024_output_cover')
ON CONFLICT (version) DO NOTHING;

COMMIT;
