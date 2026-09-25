CREATE TABLE IF NOT EXISTS public.legacy_plan_prices (
  plan_id text PRIMARY KEY,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  stripe_price_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.legacy_plan_prices ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.legacy_plan_prices TO service_role;
