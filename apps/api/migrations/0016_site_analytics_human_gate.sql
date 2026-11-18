BEGIN;

CREATE TABLE IF NOT EXISTS site_daily_analytics_visitors (
  day date NOT NULL,
  visitor_hash char(32) NOT NULL,
  region varchar(80) NOT NULL DEFAULT '地区待识别',
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, visitor_hash)
);

CREATE INDEX IF NOT EXISTS site_daily_analytics_visitors_seen_idx
  ON site_daily_analytics_visitors (last_seen_at DESC);

INSERT INTO schema_migrations(version)
VALUES ('0016_site_analytics_human_gate')
ON CONFLICT (version) DO NOTHING;

COMMIT;
