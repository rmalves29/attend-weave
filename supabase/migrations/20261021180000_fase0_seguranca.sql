-- Fase 0 — correções de segurança.
--
-- 1. Cadastro aberto: até aqui todo usuário criado em auth.users (inclusive pelo
--    signUp público da tela de login) ganhava a role 'agent' e passava a ver as
--    conversas. Agora só recebe role quem for criado por um admin pela tela de
--    usuários (createUser marca app_metadata.provisioned_by_admin = true, campo
--    que o próprio usuário não consegue alterar). Usuários existentes mantêm
--    suas roles.
-- 2. QR code de pareamento: deixa de ser legível por qualquer autenticado. O QR
--    só chega ao painel pelas server functions de admin (connect/status).
-- 3. Políticas antigas "USING (true)" em quick_replies, tags e tag_followups
--    continuavam ativas (políticas permissivas somam por OR) e anulavam as
--    políticas por role criadas depois. São removidas.
-- 4. Bucket attachments: leitura/upload passam a exigir role agent/admin.
-- 5. Perfis: só usuários com role enxergam a equipe.

-- ============ 1. CADASTRO ============
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, name, email, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    NEW.email,
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Só usuários provisionados por um admin recebem acesso automático.
  IF COALESCE(NEW.raw_app_meta_data->>'provisioned_by_admin', '') = 'true' THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'agent')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- ============ 2. QR CODE / COLUNAS DE CHANNELS ============
REVOKE SELECT ON public.channels FROM authenticated;
GRANT SELECT (id, name, type, identifier, status, last_connected_at, created_at, updated_at, history_discovery)
  ON public.channels TO authenticated;

-- ============ 3. POLÍTICAS ABERTAS ANTIGAS ============
DROP POLICY IF EXISTS "Authenticated users can view quick replies" ON public.quick_replies;
DROP POLICY IF EXISTS "Authenticated users can insert quick replies" ON public.quick_replies;
DROP POLICY IF EXISTS "Authenticated users can update quick replies" ON public.quick_replies;
DROP POLICY IF EXISTS "Authenticated users can delete quick replies" ON public.quick_replies;

DROP POLICY IF EXISTS "Authenticated can view tags" ON public.tags;
DROP POLICY IF EXISTS "Authenticated can insert tags" ON public.tags;
DROP POLICY IF EXISTS "Authenticated can update tags" ON public.tags;
DROP POLICY IF EXISTS "Authenticated can delete tags" ON public.tags;

DROP POLICY IF EXISTS "Authenticated can view tag followups" ON public.tag_followups;
DROP POLICY IF EXISTS "Authenticated can insert tag followups" ON public.tag_followups;
DROP POLICY IF EXISTS "Authenticated can update tag followups" ON public.tag_followups;
DROP POLICY IF EXISTS "Authenticated can delete tag followups" ON public.tag_followups;

-- Garante que as políticas por role existem (caso alguma migration antiga não
-- tenha rodado neste banco).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='quick_replies' AND policyname='Agents manage quick replies') THEN
    CREATE POLICY "Agents manage quick replies" ON public.quick_replies FOR ALL TO authenticated
      USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role))
      WITH CHECK (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tags' AND policyname='Agents manage tags') THEN
    CREATE POLICY "Agents manage tags" ON public.tags FOR ALL TO authenticated
      USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role))
      WITH CHECK (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tag_followups' AND policyname='Agents view followups') THEN
    CREATE POLICY "Agents view followups" ON public.tag_followups FOR SELECT TO authenticated
      USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));
  END IF;
END $$;

-- ============ 4. STORAGE: BUCKET ATTACHMENTS ============
-- O painel grava em "<conversationId>/<arquivo>" e nunca lê direto do bucket
-- (mídia chega por URL assinada gerada no servidor). Então: upload/leitura só
-- na pasta de uma conversa que o usuário enxerga (RLS de conversations vale
-- dentro da subquery); admin acessa tudo.
DROP POLICY IF EXISTS "Authenticated can upload to attachments" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can read attachments" ON storage.objects;
DROP POLICY IF EXISTS "Team can upload to attachments" ON storage.objects;
DROP POLICY IF EXISTS "Team can read attachments" ON storage.objects;
CREATE POLICY "Team can upload to attachments" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'attachments'
    AND (
      app_private.has_role(auth.uid(), 'admin'::public.app_role)
      OR EXISTS (
        SELECT 1 FROM public.conversations c
        WHERE c.id::text = (storage.foldername(name))[1]
      )
    )
  );
CREATE POLICY "Team can read attachments" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'attachments'
    AND (
      app_private.has_role(auth.uid(), 'admin'::public.app_role)
      OR EXISTS (
        SELECT 1 FROM public.conversations c
        WHERE c.id::text = (storage.foldername(name))[1]
      )
    )
  );

-- ============ 5. PERFIS ============
DROP POLICY IF EXISTS "Profiles viewable by authenticated" ON public.profiles;
DROP POLICY IF EXISTS "Team views profiles" ON public.profiles;
CREATE POLICY "Team views profiles" ON public.profiles FOR SELECT TO authenticated
  USING (
    auth.uid() = id
    OR app_private.has_role(auth.uid(), 'agent'::public.app_role)
    OR app_private.has_role(auth.uid(), 'admin'::public.app_role)
  );

-- ============ 6. LEITURA SÓ PARA A EQUIPE ============
-- Usuário sem role não vê canais (nome/número), nem configuração do bot.
ALTER POLICY "Authenticated view channels" ON public.channels
  USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));
ALTER POLICY "bot_settings read auth" ON public.bot_settings
  USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));
ALTER POLICY "menu read auth" ON public.bot_menu_options
  USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));
