# AttendFlow - Sistema de Atendimento Multicanal

Sistema estilo WhatsApp Web com tema escuro, integração Evolution API e relatórios completos.

## 1. Backend (Lovable Cloud / Supabase)

Habilitar Lovable Cloud e criar via migration:

**Tabelas:**
- `profiles` (espelho de auth.users: id, name, email, avatar_url, created_at)
- `user_roles` (id, user_id, role enum: admin/agent) — padrão seguro com função `has_role`
- `channels` (id, name, type, identifier, status, created_at)
- `contacts` (id, name, phone, email, channel_type, avatar_url, created_at)
- `conversations` (id, contact_id, channel_id, agent_id, status, started_at, first_response_at, last_inbound_at, last_outbound_at, resolved_at)
- `messages` (id, conversation_id, agent_id, direction, content, type, sent_at, read_at, is_first_message)

**Segurança:**
- RLS habilitado em todas as tabelas
- GRANTs explícitos para `authenticated` e `service_role`
- Policies: usuários autenticados podem ler/escrever; admins gerenciam agentes/canais
- Trigger `handle_new_user` cria profile + role 'agent' no signup
- Realtime habilitado em `messages` e `conversations`

**Seed de dados mock:** 3 agentes, 2 canais WhatsApp, ~15 contatos, 20 conversas, mensagens variadas ao longo dos últimos 30 dias.

## 2. Estrutura de Rotas (TanStack Start)

```
src/routes/
  __root.tsx          (já existe — adicionar QueryClient + auth listener)
  index.tsx           (redireciona p/ /atendimento ou /auth)
  auth.tsx            (login/signup)
  _authenticated/
    route.tsx         (gate de auth + layout com sidebar)
    atendimento.tsx   (página principal 3 colunas)
    atendimento.$conversationId.tsx (chat selecionado)
    relatorios.tsx
    canais.tsx
    configuracoes.tsx
```

## 3. Páginas

**Auth (`/auth`)** — email/senha via Supabase Auth, sem confirmação de email para dev.

**Atendimento** — layout 3 colunas:
- Esquerda: tabs (Todas/Abertas/Pendentes/Resolvidas), busca, filtros por canal e atendente, cards com avatar, última mensagem, hora, ícone do canal, badge não lidas, borda vermelha se sem resposta
- Centro: header do contato, bolhas estilo WhatsApp (enviadas verde #005C4B à direita, recebidas #1F2C33 à esquerda), input com anexos (imagem/áudio/doc — UI apenas), botões de status e atribuição
- Direita: perfil do contato, histórico de atendimentos, notas internas (campo editável)

**Relatórios** — filtros globais (período/canal/atendente) + 6 cards:
1. Volume de mensagens (Recharts BarChart, agrupamento hora/dia/mês/ano, recebidas vs enviadas)
2. Tempo médio de resposta (KPI + LineChart + comparativo período anterior)
3. Tempo até 1ª resposta (mesmo formato)
4. Mensagens sem resposta (KPI vermelho + lista clicável)
5. Mensagens respondidas (BarChart + taxa %)
6. Desempenho por atendente (tabela)

**Canais** — lista com status, botão "Conectar WhatsApp" abre modal com QR Code (chamada placeholder à Evolution API via server function), placeholders Instagram/Facebook, desconectar/reconectar.

**Configurações** — gestão de atendentes (admin), edição de perfil, formulário URL/API Key da Evolution API (salvo como secrets via servidor).

## 4. Camada de Dados

- `createServerFn` + `requireSupabaseAuth` para todas as queries
- TanStack Query como padrão (queryOptions + useSuspenseQuery em loaders)
- Hook `useRealtimeMessages(conversationId)` assinando `messages` via Supabase realtime e invalidando queries

## 5. Serviços (estrutura pronta, sem chamadas reais)

- `src/services/evolutionApi.ts` — sendMessage, getQRCode, getInstances, disconnectInstance (chamadas via createServerFn usando secrets EVOLUTION_API_URL e EVOLUTION_API_KEY)
- `src/services/metaApi.ts` — sendInstagramMessage, sendFacebookMessage (stubs)
- `src/hooks/useRealtimeMessages.ts`

## 6. Design System

Atualizar `src/styles.css` com tokens semânticos no modo escuro:
- `--background: #111B21`, `--card: #1F2C33`, `--primary: #00A884`
- `--message-out: #005C4B`, `--message-in: #1F2C33`
- Sidebar tokens, fonte Inter via Google Fonts
- Aplicar classe `.dark` no `<html>` por padrão

Componentes shadcn já disponíveis (sidebar, tabs, dialog, dropdown, avatar, badge, input, textarea, button, card, scroll-area).

## 7. Detalhes Técnicos

- Recharts para gráficos
- date-fns para datas/períodos
- Sidebar shadcn collapsible com ícones Lucide (MessageSquare, BarChart3, Radio, Settings)
- Mock data populado via SQL seed na migration inicial
- Evolution API: secrets `EVOLUTION_API_URL` e `EVOLUTION_API_KEY` solicitados na tela de Configurações (via `add_secret`) quando o usuário for conectar de verdade

## Ordem de implementação

1. Habilitar Lovable Cloud + migration (schema + RLS + seed)
2. Design tokens + sidebar + auth
3. Página Atendimento (lista + chat + painel contato)
4. Realtime + envio de mensagens
5. Relatórios com Recharts
6. Canais + Configurações
7. Stubs Evolution/Meta API

Quer que eu siga com esse plano ou ajuste algo (ex: pular Instagram/Facebook placeholders, simplificar relatórios, mudar paleta)?
