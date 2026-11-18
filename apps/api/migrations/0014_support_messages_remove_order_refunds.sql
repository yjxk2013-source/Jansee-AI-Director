BEGIN;

-- Retire the incomplete self-service order-refund workflow without deleting
-- any historical refund audit records or order metadata.
DO $$
BEGIN
  IF to_regclass('public.billing_refund_requests') IS NOT NULL
     AND to_regclass('public.billing_refund_requests_legacy') IS NULL THEN
    ALTER TABLE billing_refund_requests RENAME TO billing_refund_requests_legacy;
  END IF;
END
$$;

-- Failed-generation credit restoration remains active and separate from
-- customer payment refunds.

-- A simple inbound site-message channel for users to contact the operator.
CREATE TABLE IF NOT EXISTS support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  order_id text REFERENCES billing_orders(id) ON DELETE SET NULL,
  subject varchar(120) NOT NULL,
  message varchar(2000) NOT NULL,
  status text NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS support_messages_status_created_idx
  ON support_messages(status, created_at DESC);
CREATE INDEX IF NOT EXISTS support_messages_user_created_idx
  ON support_messages(user_id, created_at DESC);

INSERT INTO schema_migrations(version)
VALUES ('0014_support_messages_remove_order_refunds')
ON CONFLICT (version) DO NOTHING;

COMMIT;
