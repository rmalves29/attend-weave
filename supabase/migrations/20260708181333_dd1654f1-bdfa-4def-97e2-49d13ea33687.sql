-- Une contatos duplicados pelo mesmo telefone, mantendo o mais antigo.
WITH duplicated_contacts AS (
  SELECT
    id,
    first_value(id) OVER (PARTITION BY phone ORDER BY created_at, id) AS keep_id
  FROM public.contacts
  WHERE phone IS NOT NULL
)
UPDATE public.conversations c
SET contact_id = duplicated_contacts.keep_id
FROM duplicated_contacts
WHERE c.contact_id = duplicated_contacts.id
  AND duplicated_contacts.id <> duplicated_contacts.keep_id;

WITH duplicated_contacts AS (
  SELECT
    id,
    first_value(id) OVER (PARTITION BY phone ORDER BY created_at, id) AS keep_id
  FROM public.contacts
  WHERE phone IS NOT NULL
)
DELETE FROM public.contacts ct
USING duplicated_contacts
WHERE ct.id = duplicated_contacts.id
  AND duplicated_contacts.id <> duplicated_contacts.keep_id;

-- Une conversas duplicadas do mesmo contato no mesmo canal, mantendo a mais antiga.
WITH duplicated_conversations AS (
  SELECT
    id,
    first_value(id) OVER (PARTITION BY contact_id, channel_id ORDER BY created_at, id) AS keep_id
  FROM public.conversations
)
UPDATE public.messages m
SET conversation_id = duplicated_conversations.keep_id
FROM duplicated_conversations
WHERE m.conversation_id = duplicated_conversations.id
  AND duplicated_conversations.id <> duplicated_conversations.keep_id;

WITH duplicated_conversations AS (
  SELECT
    id,
    first_value(id) OVER (PARTITION BY contact_id, channel_id ORDER BY created_at, id) AS keep_id
  FROM public.conversations
)
DELETE FROM public.conversations cv
USING duplicated_conversations
WHERE cv.id = duplicated_conversations.id
  AND duplicated_conversations.id <> duplicated_conversations.keep_id;

-- Recalcula o resumo das conversas após a união.
UPDATE public.conversations c
SET last_message_at = latest.created_at,
    last_message_preview = latest.preview
FROM (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    created_at,
    left(coalesce(content, ''), 120) AS preview
  FROM public.messages
  ORDER BY conversation_id, created_at DESC, id DESC
) latest
WHERE latest.conversation_id = c.id;

-- Blindagens permanentes contra novas duplicatas.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_phone_unique
  ON public.contacts(phone)
  WHERE phone IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_contact_channel_unique
  ON public.conversations(contact_id, channel_id);