// Análise de atendimento com IA — processamento em segundo plano.
// Etapa 1 (map): lotes de até 8 conversas -> JSON por conversa (modelo barato).
// Etapa 2 (reduce): números calculados em código + 2 chamadas de síntese
// (modelo mais forte) -> documento Markdown + result_json estruturado.
import { AiGatewayError, callResponsesJson } from "./ai-gateway.server";

export const MAP_MODEL = "openai/gpt-6-luna";
export const REDUCE_MODEL = "openai/gpt-6-astra";
export const BATCH_SIZE = 8;
const WAVE_CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const TRANSCRIPT_LIMIT = 8000;

type Sb = any;

// ---------------- Transcrição ----------------

export function maskPII(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[cpf]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[cartão]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[telefone]");
}

const MEDIA: Record<string, string> = {
  image: "[imagem]", audio: "[áudio]", video: "[vídeo]", document: "[documento]",
  sticker: "[figurinha]", location: "[localização]",
};

const fmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});

export function buildTranscript(msgs: { direction: string; type: string; content: string | null; created_at: string }[]) {
  const lines = msgs.map((m) => {
    const who = m.direction === "inbound" ? "Cliente" : "Loja";
    const media = m.type !== "text" ? MEDIA[m.type] ?? `[${m.type}]` : "";
    const body = maskPII([media, (m.content ?? "").replace(/\s+/g, " ").trim()].filter(Boolean).join(" "));
    return `[${fmt.format(new Date(m.created_at))}] ${who}: ${body || "(vazio)"}`;
  });
  const full = lines.join("\n");
  if (full.length <= TRANSCRIPT_LIMIT) return full;
  const half = Math.floor(TRANSCRIPT_LIMIT / 2) - 40;
  return `${full.slice(0, half)}\n[... trecho do meio omitido ...]\n${full.slice(-half)}`;
}

// ---------------- Schemas ----------------

const str = { type: "string" };
const obj = (props: Record<string, any>) => ({
  type: "object", additionalProperties: false, properties: props, required: Object.keys(props),
});
const arr = (items: any) => ({ type: "array", items });

const ITEM_SCHEMA = obj({
  id: str,
  assunto: str,
  intencao_cliente: str,
  desfecho: { type: "string", enum: ["venda", "duvida_resolvida", "sem_resposta", "reclamacao", "desistiu", "outro"] },
  sentimento: { type: "string", enum: ["positivo", "neutro", "negativo"] },
  nota_atendimento: { type: "integer" },
  tempo_resposta_percebido: { type: "string", enum: ["rapido", "ok", "lento"] },
  erros: arr(obj({ tipo: str, descricao: str, trecho_curto: str })),
  acertos: arr(obj({ descricao: str, trecho_curto: str })),
  perguntas_cliente: arr(obj({ pergunta: str, resposta_dada: str, resposta_ideal: str })),
  objecoes: arr(obj({ objecao: str, como_foi_tratada: str, como_tratar: str })),
  venda_perdida: { type: "boolean" },
  motivo_venda_perdida: { type: ["string", "null"] },
});
const MAP_SCHEMA = obj({ conversas: arr(ITEM_SCHEMA) });

const CORE_SCHEMA = obj({
  resumo_executivo: str,
  acertos: arr(obj({ titulo: str, frequencia: { type: "integer" }, exemplo: str })),
  erros: arr(obj({ erro: str, frequencia: { type: "integer" }, exemplo: str, impacto: str, como_corrigir: str })),
  padrao: obj({
    saudacao: str, tom_de_voz: str, tempo_resposta: str, produto_preco: str,
    fechamento: str, pedir_dados: str, encerramento: str, nunca_fazer: arr(str),
  }),
  checklist: arr(str),
  plano_acao: arr(obj({ acao: str, responsavel: str, prazo: str })),
});

export const TEMAS = [
  "Preço", "Frete e prazo", "Pagamento / Pix / parcelamento", "Troca e devolução",
  "Disponibilidade / estoque", "Medidas / tamanho", "Qualidade / material", "Pedido e rastreio", "Outros",
];
const BANCO_SCHEMA = obj({
  banco: arr(obj({ tema: { type: "string", enum: TEMAS }, pergunta: str, resposta: str, confirmar: { type: "boolean" } })),
  objecoes: arr(obj({ objecao: str, frequencia: { type: "integer" }, como_contornar: str })),
});

const MAP_INSTRUCTIONS = `Você é um auditor de qualidade de atendimento de uma loja que vende pelo WhatsApp.
Receberá várias conversas (cada uma com um id). "Cliente" é o consumidor; "Loja" é a equipe.
Para CADA conversa devolva um objeto em "conversas" com o mesmo id, avaliando o atendimento da Loja.
- nota_atendimento: inteiro de 1 a 5.
- trecho_curto: até 120 caracteres, copiado da conversa, sem dados pessoais.
- perguntas_cliente: perguntas relevantes do cliente, a resposta que a loja deu ("" se não respondeu) e uma resposta ideal curta (não invente preços, prazos ou políticas: use [confirmar] quando depender disso).
- motivo_venda_perdida: null quando venda_perdida for false.
Listas podem ser vazias. Escreva em português do Brasil.`;

// ---------------- Etapa 1 ----------------

async function loadTranscripts(sb: Sb, a: any, convIds: string[]) {
  const out: Record<string, string> = {};
  await Promise.all(convIds.map(async (cid) => {
    const { data } = await sb.from("messages")
      .select("direction, type, content, created_at")
      .eq("conversation_id", cid).eq("is_internal", false)
      .gte("created_at", a.since).lt("created_at", a.until)
      .order("created_at", { ascending: true }).limit(1000);
    out[cid] = buildTranscript(data ?? []);
  }));
  return out;
}

async function failItems(sb: Sb, items: any[], error: string) {
  for (const it of items) {
    const attempts = (it.attempts ?? 0) + 1;
    await sb.from("ai_analysis_items").update({
      attempts, error: error.slice(0, 500), status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
    }).eq("id", it.id);
  }
}

async function runBatch(sb: Sb, a: any, items: any[]) {
  const transcripts = await loadTranscripts(sb, a, items.map((i) => i.conversation_id));
  const keyed = items.map((it, i) => ({ key: `c${i + 1}`, it }));
  const ctx = a.store_context?.trim() ? `Contexto da loja: ${maskPII(a.store_context.trim()).slice(0, 2000)}\n\n` : "";
  const input = ctx + keyed.map(({ key, it }) => `=== Conversa id=${key} ===\n${transcripts[it.conversation_id] || "(sem mensagens)"}`).join("\n\n");
  try {
    const { value } = await callResponsesJson<{ conversas: any[] }>({
      model: MAP_MODEL, instructions: MAP_INSTRUCTIONS, input,
      schemaName: "analise_conversas", schema: MAP_SCHEMA, effort: "low",
    });
    const byKey = new Map((value.conversas ?? []).map((c) => [c.id, c]));
    const missing: any[] = [];
    for (const { key, it } of keyed) {
      const r = byKey.get(key);
      if (!r) { missing.push(it); continue; }
      const { id: _drop, ...result } = r;
      result.nota_atendimento = Math.min(5, Math.max(1, Number(result.nota_atendimento) || 3));
      await sb.from("ai_analysis_items").update({ status: "done", result, error: null }).eq("id", it.id);
    }
    if (missing.length) await failItems(sb, missing, "conversa ausente na resposta da IA");
  } catch (e) {
    if (e instanceof AiGatewayError && (e.status === 402 || e.status === 403 || e.status === 401)) throw e;
    await failItems(sb, items, e instanceof Error ? e.message : String(e));
  }
}

async function refreshProgress(sb: Sb, id: string) {
  const [{ count: done }, { count: failed }] = await Promise.all([
    sb.from("ai_analysis_items").select("id", { count: "exact", head: true }).eq("analysis_id", id).eq("status", "done"),
    sb.from("ai_analysis_items").select("id", { count: "exact", head: true }).eq("analysis_id", id).eq("status", "failed"),
  ]);
  await sb.from("ai_analyses").update({
    processed_conversations: (done ?? 0) + (failed ?? 0), failed_conversations: failed ?? 0,
  }).eq("id", id);
}

// ---------------- Etapa 2 ----------------

function countBy<T>(xs: T[], f: (x: T) => string | null | undefined) {
  const m = new Map<string, number>();
  for (const x of xs) { const k = f(x); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function takeChars(lines: string[], max: number) {
  const out: string[] = [];
  let n = 0;
  for (const l of lines) { if (n + l.length > max) break; out.push(l); n += l.length + 1; }
  return out.join("\n");
}

export function computeNumbers(results: any[]) {
  const n = results.length;
  const desfecho = countBy(results, (r) => r.desfecho);
  const sentimento = countBy(results, (r) => r.sentimento);
  const nota = n ? results.reduce((s, r) => s + (r.nota_atendimento ?? 0), 0) / n : 0;
  const lost = results.filter((r) => r.venda_perdida);
  const motivos = countBy(lost, (r) => r.motivo_venda_perdida?.trim().toLowerCase()).slice(0, 8);
  const semResposta = results.filter((r) => r.desfecho === "sem_resposta").length;
  const tempo = countBy(results, (r) => r.tempo_resposta_percebido);
  return { n, desfecho, sentimento, nota, vendas_perdidas: lost.length, motivos, sem_resposta: semResposta, tempo };
}

const P = (x: number, n: number) => (n ? `${Math.round((x / n) * 100)}%` : "—");
const DESFECHO_LABEL: Record<string, string> = {
  venda: "Venda", duvida_resolvida: "Dúvida resolvida", sem_resposta: "Sem resposta",
  reclamacao: "Reclamação", desistiu: "Desistiu", outro: "Outro",
};

async function runReduce(sb: Sb, a: any) {
  const { data: rows } = await sb.from("ai_analysis_items").select("result")
    .eq("analysis_id", a.id).eq("status", "done").limit(2000);
  const results = (rows ?? []).map((r: any) => r.result).filter(Boolean);
  if (!results.length) throw new Error("Nenhuma conversa foi analisada com sucesso.");
  const nums = computeNumbers(results);
  const parts = { ...(a.result_json?.parts ?? {}) };
  const ctx = a.store_context?.trim() ? `CONTEXTO DA LOJA (fonte única de políticas):\n${a.store_context.trim().slice(0, 3000)}` : "CONTEXTO DA LOJA: não informado — toda política, prazo ou preço deve ser marcado [confirmar].";
  const numbersTxt = `Conversas analisadas: ${nums.n}. Nota média: ${nums.nota.toFixed(2)}. Desfechos: ${nums.desfecho.map(([k, v]) => `${k}=${v}`).join(", ")}. Sentimento: ${nums.sentimento.map(([k, v]) => `${k}=${v}`).join(", ")}. Vendas perdidas: ${nums.vendas_perdidas}. Motivos: ${nums.motivos.map(([k, v]) => `${k} (${v})`).join("; ")}.`;

  if (!parts.core) {
    const erros = countBy(results.flatMap((r: any) => (r.erros ?? []).map((e: any) => `${e.tipo}: ${e.descricao}`.toLowerCase())), (x) => x);
    const errosEx = results.flatMap((r: any) => (r.erros ?? []).map((e: any) => `- [${e.tipo}] ${e.descricao} | "${e.trecho_curto}"`));
    const acertosEx = results.flatMap((r: any) => (r.acertos ?? []).map((e: any) => `- ${e.descricao} | "${e.trecho_curto}"`));
    const assuntos = countBy(results, (r: any) => r.assunto?.toLowerCase()).slice(0, 40);
    const input = [
      ctx, "", `NÚMEROS: ${numbersTxt}`,
      `ASSUNTOS MAIS COMUNS: ${assuntos.map(([k, v]) => `${k} (${v})`).join("; ")}`,
      `\nERROS (agrupados, contagem):\n${takeChars(erros.map(([k, v]) => `${v}x ${k}`), 25000)}`,
      `\nEXEMPLOS DE ERROS:\n${takeChars(errosEx, 25000)}`,
      `\nEXEMPLOS DE ACERTOS:\n${takeChars(acertosEx, 25000)}`,
    ].join("\n");
    const { value } = await callResponsesJson<any>({
      model: REDUCE_MODEL, schemaName: "relatorio_atendimento", schema: CORE_SCHEMA, effort: "low", input,
      instructions: `Você é consultor sênior de atendimento e vendas pelo WhatsApp. A partir dos dados agregados de ${nums.n} conversas, escreva em português do Brasil:
- resumo_executivo: 5 a 8 linhas, citando números.
- acertos: 5 a 8 itens (frequência aproximada e 1 exemplo curto anonimizado).
- erros: priorizados por impacto x frequência (mais grave primeiro), com impacto e como corrigir.
- padrao: padrão de atendimento prático e específico (com frases-modelo).
- checklist: exatamente 10 itens curtos.
- plano_acao: exatamente 5 ações com responsável sugerido (cargo) e prazo.
Nunca invente preço, prazo ou política que não esteja no contexto da loja: escreva [confirmar].`,
    });
    parts.core = value;
    await sb.from("ai_analyses").update({ result_json: { ...(a.result_json ?? {}), parts } }).eq("id", a.id);
    return false; // banco de respostas na próxima rodada
  }

  if (!parts.banco) {
    const perguntas = results.flatMap((r: any) => (r.perguntas_cliente ?? []).map((p: any) => `- P: ${p.pergunta} | Dada: ${p.resposta_dada || "(sem resposta)"} | Ideal: ${p.resposta_ideal}`));
    const objecoes = results.flatMap((r: any) => (r.objecoes ?? []).map((o: any) => `- ${o.objecao} | tratada: ${o.como_foi_tratada} | sugerido: ${o.como_tratar}`));
    const input = [ctx, "", `PERGUNTAS DE CLIENTES:\n${takeChars(perguntas, 50000)}`, `\nOBJEÇÕES:\n${takeChars(objecoes, 20000)}`].join("\n");
    const { value } = await callResponsesJson<any>({
      model: REDUCE_MODEL, schemaName: "banco_respostas", schema: BANCO_SCHEMA, effort: "low", input,
      instructions: `Monte um banco de respostas para atendentes de WhatsApp, em português do Brasil.
- banco: 3 a 6 itens por tema relevante (perguntas mais frequentes primeiro). "resposta" pronta para enviar, cordial e curta, baseada nas melhores respostas reais observadas, melhoradas.
- Quando a resposta depender de preço, prazo, frete, troca, pagamento ou política que NÃO está no contexto da loja, inclua [confirmar] no texto e marque confirmar=true. Nunca invente valores.
- objecoes: as mais comuns, com frequência aproximada e como contornar.`,
    });
    parts.banco = value;
  }

  const md = buildMarkdown(a, nums, parts.core, parts.banco);
  await sb.from("ai_analyses").update({
    status: "done", finished_at: new Date().toISOString(), result_markdown: md,
    result_json: { parts, numbers: nums, banco: parts.banco.banco, sections: SECTION_TITLES },
  }).eq("id", a.id);
  return true;
}

export const SECTION_TITLES = [
  "1. Resumo executivo", "2. Números do período", "3. O que está sendo feito certo",
  "4. O que está sendo feito errado", "5. Padrão de atendimento", "6. Banco de respostas",
  "7. Objeções mais comuns", "8. Checklist do atendente", "9. Plano de ação",
];

function buildMarkdown(a: any, nums: ReturnType<typeof computeNumbers>, core: any, banco: any) {
  const d = (s: string) => new Date(s).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const L: string[] = [];
  L.push(`# Análise de atendimento — ${d(a.since)} a ${d(a.until)}`, "");
  L.push(`_${nums.n} conversas analisadas${a.sampled ? " (amostra das mais recentes)" : ""}. Gerado com Lovable AI._`, "");
  L.push(`## ${SECTION_TITLES[0]}`, "", core.resumo_executivo, "");
  L.push(`## ${SECTION_TITLES[1]}`, "", "| Indicador | Valor |", "|---|---|");
  L.push(`| Conversas analisadas | ${nums.n} |`, `| Nota média do atendimento | ${nums.nota.toFixed(1)} / 5 |`);
  L.push(`| Sem resposta | ${P(nums.sem_resposta, nums.n)} (${nums.sem_resposta}) |`, `| Vendas perdidas | ${nums.vendas_perdidas} |`);
  for (const [k, v] of nums.desfecho) L.push(`| Desfecho: ${DESFECHO_LABEL[k] ?? k} | ${P(v, nums.n)} (${v}) |`);
  for (const [k, v] of nums.sentimento) L.push(`| Sentimento ${k} | ${P(v, nums.n)} |`);
  L.push("");
  if (nums.motivos.length) {
    L.push("**Principais motivos de venda perdida:**", "");
    for (const [k, v] of nums.motivos) L.push(`- ${k} (${v})`);
    L.push("");
  }
  L.push(`## ${SECTION_TITLES[2]}`, "");
  for (const x of core.acertos) L.push(`- **${x.titulo}** (≈${x.frequencia}x) — _"${x.exemplo}"_`);
  L.push("", `## ${SECTION_TITLES[3]}`, "");
  core.erros.forEach((x: any, i: number) => {
    L.push(`### ${i + 1}. ${x.erro} (≈${x.frequencia}x)`, "", `- **Exemplo:** _"${x.exemplo}"_`, `- **Impacto:** ${x.impacto}`, `- **Como corrigir:** ${x.como_corrigir}`, "");
  });
  const p = core.padrao;
  L.push(`## ${SECTION_TITLES[4]}`, "");
  L.push(`- **Saudação:** ${p.saudacao}`, `- **Tom de voz:** ${p.tom_de_voz}`, `- **Tempo de resposta esperado:** ${p.tempo_resposta}`);
  L.push(`- **Produto e preço:** ${p.produto_preco}`, `- **Fechamento da venda:** ${p.fechamento}`, `- **Como pedir dados:** ${p.pedir_dados}`, `- **Encerramento:** ${p.encerramento}`);
  L.push("", "**O que nunca fazer:**", "", ...p.nunca_fazer.map((x: string) => `- ${x}`), "");
  L.push(`## ${SECTION_TITLES[5]}`, "");
  for (const tema of TEMAS) {
    const items = banco.banco.filter((b: any) => b.tema === tema);
    if (!items.length) continue;
    L.push(`### ${tema}`, "");
    for (const b of items) L.push(`- **Se o cliente perguntar:** ${b.pergunta}`, `  **→ Responda:** ${b.resposta}${b.confirmar && !b.resposta.includes("[confirmar]") ? " [confirmar]" : ""}`);
    L.push("");
  }
  L.push(`## ${SECTION_TITLES[6]}`, "");
  for (const o of banco.objecoes) L.push(`- **${o.objecao}** (≈${o.frequencia}x) — ${o.como_contornar}`);
  L.push("", `## ${SECTION_TITLES[7]}`, "", ...core.checklist.map((x: string) => `- [ ] ${x}`), "");
  L.push(`## ${SECTION_TITLES[8]}`, "", "| # | Ação | Responsável | Prazo |", "|---|---|---|---|");
  core.plano_acao.forEach((x: any, i: number) => L.push(`| ${i + 1} | ${x.acao} | ${x.responsavel} | ${x.prazo} |`));
  return L.join("\n");
}

// ---------------- Orquestração ----------------

export async function processAnalysis(sb: Sb, id: string, deadline: number) {
  const { data: a } = await sb.from("ai_analyses").select("*").eq("id", id).maybeSingle();
  if (!a || !["queued", "running", "summarizing"].includes(a.status)) return { id, status: a?.status };
  try {
    if (a.status === "queued") await sb.from("ai_analyses").update({ status: "running" }).eq("id", id);

    if (a.status !== "summarizing") {
      // Ondas de até 4 lotes paralelos enquanto houver tempo (~45s por onda).
      while (Date.now() < deadline - 50_000) {
        const { data: items } = await sb.from("ai_analysis_items")
          .select("id, conversation_id, attempts").eq("analysis_id", id).eq("status", "pending")
          .order("created_at").limit(BATCH_SIZE * WAVE_CONCURRENCY);
        if (!items?.length) {
          await sb.from("ai_analyses").update({ status: "summarizing" }).eq("id", id);
          a.status = "summarizing";
          break;
        }
        const batches: any[][] = [];
        for (let i = 0; i < items.length; i += BATCH_SIZE) batches.push(items.slice(i, i + BATCH_SIZE));
        await Promise.all(batches.map((b) => runBatch(sb, a, b)));
        await refreshProgress(sb, id);
      }
    }

    if (a.status === "summarizing" && Date.now() < deadline - 60_000) {
      const { data: fresh } = await sb.from("ai_analyses").select("*").eq("id", id).maybeSingle();
      await runReduce(sb, fresh);
    }
    const { data: end } = await sb.from("ai_analyses").select("status").eq("id", id).maybeSingle();
    return { id, status: end?.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 401/402/403 e falhas da síntese encerram a análise com erro visível.
    const terminal = e instanceof AiGatewayError ? !e.retryable : true;
    if (terminal) {
      await sb.from("ai_analyses").update({ status: "error", error: msg.slice(0, 1000), finished_at: new Date().toISOString() }).eq("id", id);
    }
    return { id, status: terminal ? "error" : a.status, error: msg };
  }
}
