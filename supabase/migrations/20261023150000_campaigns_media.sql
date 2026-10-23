-- Anexo de mídia nas campanhas: imagem, vídeo, áudio ou documento.
-- O arquivo é enviado uma vez pro bucket "attachments" e reusado em todos os
-- disparos; a mensagem da campanha vira a legenda. Se não houver mídia, envia
-- texto (comportamento atual).
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS media_path TEXT,          -- caminho no bucket attachments
  ADD COLUMN IF NOT EXISTS media_type TEXT,          -- image | video | audio | document
  ADD COLUMN IF NOT EXISTS media_filename TEXT,
  ADD COLUMN IF NOT EXISTS media_mime TEXT;

-- Com mídia, a mensagem (legenda) pode ser vazia.
ALTER TABLE public.campaigns ALTER COLUMN message_template DROP NOT NULL;
