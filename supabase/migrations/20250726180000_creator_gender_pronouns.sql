-- Explicit gender/pronouns for avatar + interview identity (never infer from name).
ALTER TABLE legacy_creators
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS pronouns text;

COMMENT ON COLUMN legacy_creators.gender IS 'Explicit profile gender: female|male|non_binary|unspecified|prefer_not_to_say';
COMMENT ON COLUMN legacy_creators.pronouns IS 'Explicit pronouns e.g. she/her, he/him, they/them';
