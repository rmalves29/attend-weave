# Roadmap — AttendFlow (sistema de atendimento WhatsApp)

Sistema de conversação entre atendentes e clientes. Base: TanStack Start + Supabase + UazAPI.

## ✅ Fase 0 — Fundação (concluída)
- Inbox compartilhado multi-instância WhatsApp (uazapi)
- Envio/recepção de texto e mídia (imagem, vídeo, áudio, documento)
- Responder (quote), encaminhar, apagar mensagem, emoji picker
- Conversa única por contato (modelo WhatsApp), dedup por external_id
- Sync de histórico, mídia com URL assinada + proxy + decriptação
- RLS granular (admin/agente), credenciais protegidas, webhook autenticado

## ✅ Fase 1 — Operação de equipe (implementada em 2026-07-09)
- [x] **ACKs reais**: webhook trata `messages_update` → ✓ enviado, ✓✓ entregue, ✓✓ azul lido (status nunca rebaixa)
- [x] **Respostas rápidas**: digite `/atalho` no chat; CRUD em Configurações (tabela `quick_replies`)
- [x] **Notas internas**: botão 📝 no chat — mensagem amarela visível só pela equipe, nunca vai pro WhatsApp (`messages.is_internal`)
- [x] **Transferir conversa**: header do chat → lista de atendentes (server fn valida permissão)
- [x] **Resolver/Reabrir**: botão no header; resolvida reabre sozinha se o cliente mandar mensagem
- [x] **Notificações**: beep (WebAudio) + notificação desktop quando a aba está em segundo plano
- [x] **Tags editáveis**: adicionar/remover no painel do contato

## Fase 2 — Produtividade
- [x] **Mensagens agendadas / follow-up** (implementado em 2026-07-09): botão 🕐 no composer agenda texto pra data/hora futura; tabela `scheduled_messages`, dispatcher em `/api/public/dispatch-scheduled-messages` chamado pelo pg_cron a cada minuto (ver migration `20260710090000_scheduled_messages.sql`). **Setup necessário antes de funcionar em produção:** habilitar extensões `pg_cron`/`pg_net` no projeto, configurar a env var `CRON_SECRET` na aplicação e rodar `ALTER DATABASE postgres SET app.settings.cron_secret = '<mesmo valor de CRON_SECRET>';` no SQL editor do Supabase.
- [x] **Colisão de agentes**: indicador no header do chat mostrando outros atendentes vendo a mesma conversa agora (Supabase Realtime Presence, hook `usePresence`, sem tabela nova).
- [x] **Menções @ em notas internas**: autocomplete de `@atendente` no modo nota; notifica (som + notificação desktop) quem foi mencionado via realtime.
- [ ] Distribuição automática round-robin de conversas novas
- [ ] Horário de atendimento + resposta automática fora do expediente
- [ ] Filas/departamentos (vendas, pós-venda, troca)
- [ ] Busca full-text no histórico (texto, telefone, tag)
- [ ] Campos editáveis do contato (nome, e-mail, observações, aniversário)

## Fase 3 — Integração OrderZaps (diferencial)
- [ ] Painel do cliente ao lado do chat: pedidos abertos/pagos, total gasto, última compra
- [ ] Status de consentimento v2 e mensagens automáticas recebidas
- [ ] Ações no chat: criar pedido, enviar link de checkout, reenviar rastreio
- Ambos usam Supabase — expor API de leitura no projeto OrderZaps (live-launchpad-79)

## Fase 4 — IA
- [ ] Transcrição de áudio do cliente (áudio → texto no balão)
- [ ] Sugestão de resposta com base no histórico + pedido
- [ ] Resumo da conversa ao transferir
- [ ] Pré-atendimento por bot (rastreio/status fora do horário)

## Fase 5 — Gestão
- [x] **Métricas por atendente** (implementado em 2026-07-09): tela de Relatórios reescrita — fluxo recebidas×enviadas por dia, KPIs, tabela de desempenho (conversas atendidas, msgs enviadas, resolvidas, tempo médio de 1ª resposta). Colunas novas `conversations.resolved_at/resolved_by` gravadas ao resolver e limpas ao reabrir (backfill aproximado via `updated_at`).
- [x] **Relatórios agregados no banco** (mesma data): funções SQL `report_overview`, `report_daily_flow`, `report_agent_performance` chamadas via RPC com service role (migration `20260710120000`) — corrige a tela antiga que puxava todas as linhas no client (truncava em 1000 pelo PostgREST) e mostrava só as conversas visíveis pela RLS do agente logado.
- [ ] CSAT automático ao resolver ("avalie de 1 a 5")

## Dívidas técnicas conhecidas
- Stubs mortos: `src/services/evolutionApi.ts` e `metaApi.ts` (padrão VITE_ inseguro) — apagar
- Migração redundante `20260709120000` (duplica a `20260708181333`) — inócua, remover quando conveniente
- Secret de assinatura de mídia reutiliza `UAZAPI_ADMIN_TOKEN` — considerar `MEDIA_SIGNING_SECRET` dedicado
