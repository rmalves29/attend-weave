-- =====================================================================
-- Modelo WhatsApp: 1 contato = 1 conversa por canal, para sempre.
-- 1) Mescla contatos duplicados (mesmo telefone) — race condition do webhook
-- 2) Mescla conversas duplicadas (mesmo contato+canal), movendo as mensagens
-- 3) Constraints UNIQUE para impedir novas duplicatas
-- Nenhuma mensagem é apagada — apenas re-apontada para a conversa mais antiga.
-- =====================================================================

-- 1) CONTATOS: re-aponta conversas dos contatos duplicados para o mais antigo
WITH d AS (
  SELECT id,
         first_value(id) OVER (PARTITION BY phone ORDER BY created_at, id) AS keep_id
  FROM public.contacts
  WHERE phone IS NOT NULL
)
UPDATE public.conversations c
SET contact_id = d.keep_id
FROM d
WHERE c.contact_id = d.id AND d.id <> d.keep_id;

WITH d AS (
  SELECT id,
         first_value(id) OVER (PARTITION BY phone ORDER BY created_at, id) AS keep_id
  FROM public.contacts
  WHERE phone IS NOT NULL
)
DELETE FROM public.contacts ct
USING d
WHERE ct.id = d.id AND d.id <> d.keep_id;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_phone_unique
  ON public.contacts(phone) WHERE phone IS NOT NULL;

-- 2) CONVERSAS: move mensagens das duplicadas para a conversa mais antiga
WITH d AS (
  SELECT id,
         first_value(id) OVER (PARTITION BY contact_id, channel_id ORDER BY created_at, id) AS keep_id
  FROM public.conversations
)
UPDATE public.messages m
SET conversation_id = d.keep_id
FROM d
WHERE m.conversation_id = d.id AND d.id <> d.keep_id;

WITH d AS (
  SELECT id,
         first_value(id) OVER (PARTITION BY contact_id, channel_id ORDER BY created_at, id) AS keep_id
  FROM public.conversations
)
DELETE FROM public.conversations cv
USING d
WHERE cv.id = d.id AND d.id <> d.keep_id;

-- Recalcula preview e last_message_at das conversas que absorveram mensagens
UPDATE public.conversations c
SET last_message_at = sub.max_at,
    last_message_preview = sub.preview
FROM (
  SELECT DISTINCT ON (conversation_id)
         conversation_id,
         created_at AS max_at,
         left(coalesce(content, ''), 120) AS preview
  FROM public.messages
  ORDER BY conversation_id, created_at DESC
) sub
WHERE sub.conversation_id = c.id;

-- 3) Blindagem: nunca mais duas conversas para o mesmo contato+canal
CREATE UNIQUE INDEX IF NOT EXISTS conversations_contact_channel_unique
  ON public.conversations(contact_id, channel_id);
