
# Expansão do relatório gerencial

Vou entregar os 4 blocos escolhidos em uma única leva, reorganizando a página `/relatorios` em abas para não virar uma parede de gráficos. Toda a agregação continua no Postgres via RPC com `service_role` (mesmo padrão dos relatórios atuais).

## Estrutura nova da tela

Header com filtros globais (período `7 / 30 / 90 dias` — já existe) + **novo filtro por canal** (multi-select) e 4 abas:

1. **Visão geral** — KPIs atuais + Δ% vs. período anterior + gráfico de fluxo diário
2. **SLA & tempos** — percentis, % dentro do SLA, fila em aberto agora, heatmap de pico
3. **Equipe** — desempenho por atendente enriquecido (AHT, carga simultânea, 1º contato, presença)
4. **Assuntos & canais** — top tags, quebra por canal, follow-ups

## Bloco 1 — SLA + percentis + fila em aberto

**Novos KPIs / gráficos:**
- % de conversas com 1ª resposta em ≤ 5 min, ≤ 15 min, ≤ 1 h (barras empilhadas)
- p50 / p90 / p95 de tempo de 1ª resposta e de resolução (tabela compacta)
- **Fila agora**: nº de conversas abertas sem resposta + idade da mais antiga (KPI destacado, cor conforme threshold)
- Heatmap dia da semana × hora com volume de mensagens recebidas (recharts `<ScatterChart>` com células coloridas)

**Configuração de SLA:** por ora fixo em 5/15/60 min (constantes no server fn). Se quiser configurável depois, viraria uma tabela `sla_settings`.

## Bloco 2 — Produtividade da equipe

Estender `report_agent_performance` e adicionar colunas na tabela de atendentes:
- **AHT** (Average Handle Time): média de `resolved_at - first_response_at` por atendente
- **Carga simultânea média** e **pico**: nº de conversas com status `open`/`pending` atribuídas ao agente ao longo do período (amostragem por hora)
- **Taxa de resolução no 1º contato**: conversas resolvidas onde só houve um bloco `inbound → outbound`
- **Online agora**: usando `usePresence` já existente (badge verde na linha)

## Bloco 3 — Assuntos & canais

- **Top 10 tags** no período (bar chart horizontal) — join `conversations` × `tags` via tabela de relacionamento existente
- **Quebra por canal**: mini-tabela com recebidas / enviadas / conversas / 1ª resposta média por `channel_id`
- **Follow-ups** (`tag_followups`): 3 KPIs — agendados, enviados, cancelados no período + lista dos próximos 10 pendentes

## Bloco 4 — Comparativo com período anterior

Para cada KPI da Visão geral (recebidas, enviadas, atendidas, resolvidas, 1ª resposta média, resolução média), calcular o mesmo valor no período imediatamente anterior de mesmo tamanho e mostrar Δ% ao lado (verde se melhora, vermelho se piora — sinal invertido para tempos, onde menor é melhor).

## Mudanças técnicas

### Migration (novas funções RPC)
- `report_overview_v2(_since, _until)` — recebe janela explícita para reaproveitar no comparativo; adiciona `open_now_count`, `oldest_open_secs`, `first_response_p50/p90/p95`, `resolution_p50/p90/p95`, buckets de SLA
- `report_daily_flow` — adicionar parâmetro `_channel_ids uuid[] default null` para filtro
- `report_agent_performance_v2` — adicionar `aht_secs`, `first_contact_resolution_count`, `concurrent_avg`, `concurrent_peak`
- `report_hourly_heatmap(_since)` — retorna `dow int, hour int, inbound bigint`
- `report_top_tags(_since, _limit)` — retorna `tag_id, tag_name, tag_color, conversations_count`
- `report_channel_breakdown(_since)` — por canal
- `report_followups_summary(_since)` — contagens + próximos pendentes

Todas `STABLE SECURITY DEFINER`, `REVOKE PUBLIC` + `GRANT EXECUTE TO service_role` (mesmo padrão das atuais).

### Server functions (`src/lib/reports.functions.ts`)
- Substituir `getReportMetrics` por versão que aceita `{ days, channelIds?, includeComparison? }` e retorna estrutura ampliada
- Adicionar `getSlaMetrics`, `getTeamMetrics`, `getTopicsMetrics` (uma por aba, cada uma chamando 1–3 RPCs) para carregar por demanda ao trocar de aba

### UI (`src/routes/_authenticated/relatorios.tsx`)
- Refatorar em componentes `<OverviewTab>`, `<SlaTab>`, `<TeamTab>`, `<TopicsTab>` no mesmo arquivo (ou pasta `_components/`)
- Adicionar shadcn `<Tabs>` (já disponível)
- Novo componente `<DeltaBadge value={pct} inverted={false} />` para o comparativo
- MultiSelect de canais (usar shadcn `Popover` + `Command` — já disponíveis)

### Escopo intencionalmente fora
- CSAT/NPS, sentimento, categorização por IA (você marcou como "requer nova coleta" na conversa anterior — fica para outra rodada)
- SLA configurável via UI (fixo por enquanto)
- Export CSV/PDF

## Ordem de execução
1. Criar migration com todas as RPCs novas
2. Reescrever `reports.functions.ts` com as 4 server functions
3. Refatorar a página em abas + componentes de KPI/delta
4. Verificar visualmente cada aba com Playwright

Confirma que posso seguir com esse escopo? Se quiser cortar algo (ex.: deixar comparativo pra depois, ou não fazer o heatmap agora), me diz antes de eu começar.
