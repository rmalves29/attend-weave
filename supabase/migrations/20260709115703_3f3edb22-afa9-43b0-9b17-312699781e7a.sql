ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_messages_conversation_internal ON public.messages(conversation_id, is_internal);
NOTIFY pgrst, 'reload schema';