BEGIN;

CREATE TABLE IF NOT EXISTS site_inbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(80) UNIQUE,
  subject varchar(120) NOT NULL,
  body text NOT NULL,
  category varchar(24) NOT NULL DEFAULT 'notice' CHECK (category IN ('welcome', 'features', 'notice')),
  status varchar(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS site_inbox_messages_status_published_idx
  ON site_inbox_messages(status, published_at DESC);

CREATE TABLE IF NOT EXISTS site_inbox_reads (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES site_inbox_messages(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);

INSERT INTO site_inbox_messages (slug, subject, body, category, status, published_at)
VALUES
  ('welcome-v1', '欢迎加入简兮 JANSEE', '欢迎使用简兮JANSEE AI智能导演系统。上传图片或视频，告诉导演你的创作想法，即可开始制作。祝你创作顺利！', 'welcome', 'published', now()),
  ('features-v1', '简兮功能指南', '简兮提供图片成片、视频配音、出镜口播、切片分镜等创作功能。上传素材、描述需求、确认导演方案，即可生成作品。生成后的作品可在“我的作品”中查看；积分明细和订单记录可在左侧菜单查询。', 'features', 'published', now())
ON CONFLICT (slug) DO NOTHING;

INSERT INTO schema_migrations(version)
VALUES ('0018_site_inbox')
ON CONFLICT (version) DO NOTHING;

COMMIT;
