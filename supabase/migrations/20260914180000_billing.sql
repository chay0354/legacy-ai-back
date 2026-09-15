-- Customer billing (Stripe). One row per paying user — not per archive.
CREATE TABLE IF NOT EXISTS legacy_billing (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text,
  plan text NOT NULL DEFAULT 'none' CHECK (plan IN ('none', 'archive', 'family')),
  status text NOT NULL DEFAULT 'none',
  price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_legacy_billing_customer ON legacy_billing(stripe_customer_id);

ALTER TABLE legacy_billing ENABLE ROW LEVEL SECURITY;

GRANT ALL ON legacy_billing TO service_role;
GRANT SELECT ON legacy_billing TO authenticated;

DROP POLICY IF EXISTS legacy_billing_select ON legacy_billing;
DROP POLICY IF EXISTS legacy_billing_upsert ON legacy_billing;

CREATE POLICY legacy_billing_select ON legacy_billing FOR SELECT
  USING (user_id = auth.uid());
