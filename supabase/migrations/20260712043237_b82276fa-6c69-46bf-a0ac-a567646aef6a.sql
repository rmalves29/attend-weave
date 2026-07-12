
ALTER TABLE public.tags
  ADD COLUMN IF NOT EXISTS auto_message_mode text NOT NULL DEFAULT 'relative',
  ADD COLUMN IF NOT EXISTS auto_message_unit text NOT NULL DEFAULT 'hours',
  ADD COLUMN IF NOT EXISTS auto_message_value integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS auto_message_at timestamptz NULL;

ALTER TABLE public.tags
  DROP CONSTRAINT IF EXISTS tags_auto_message_mode_check,
  ADD CONSTRAINT tags_auto_message_mode_check CHECK (auto_message_mode IN ('relative','absolute'));

ALTER TABLE public.tags
  DROP CONSTRAINT IF EXISTS tags_auto_message_unit_check,
  ADD CONSTRAINT tags_auto_message_unit_check CHECK (auto_message_unit IN ('minutes','hours','days'));

-- backfill a partir de auto_message_hours quando existente
UPDATE public.tags
SET auto_message_value = COALESCE(auto_message_hours, 24),
    auto_message_unit = 'hours',
    auto_message_mode = 'relative'
WHERE auto_message_value = 24 AND auto_message_unit = 'hours' AND auto_message_mode = 'relative';
