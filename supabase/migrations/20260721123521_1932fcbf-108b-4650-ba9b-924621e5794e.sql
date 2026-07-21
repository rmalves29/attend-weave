-- Dedup de mensagens duplicadas geradas pelo sync do histórico.
-- Webhook grava external_id como "<jid>:<HEX>"; sync grava "<HEX>".
-- Passo 1: apagar duplicatas (mantém a linha mais antiga por (conversation_id, hex normalizado)).
WITH normalized AS (
  SELECT id, conversation_id,
         COALESCE(NULLIF(regexp_replace(external_id, '^\d+:', ''), ''), external_id) AS norm_id,
         created_at
  FROM public.messages
  WHERE external_id IS NOT NULL
),
ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY conversation_id, norm_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM normalized
)
DELETE FROM public.messages m
USING ranked r
WHERE m.id = r.id AND r.rn > 1;

-- Passo 2: normaliza os external_ids restantes pro formato sem prefixo do jid.
UPDATE public.messages
SET external_id = regexp_replace(external_id, '^\d+:', '')
WHERE external_id ~ '^\d+:';