CREATE TABLE IF NOT EXISTS public.legacy_design_theme (
  id text PRIMARY KEY,
  tokens jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.legacy_design_theme ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.legacy_design_theme TO service_role;
