// Chatbot de boas-vindas: envia menu de opções no primeiro contato (ou após
// FINALIZADO), interpreta a escolha do cliente e executa a ação configurada
// (responder com texto ou encaminhar para atendente). Aplica a tag "boot"
// enquanto o bot está no controle; quando um atendente responde, a
// sendTextViaUazapi limpa esse estado.

async function uazapiSendText(
  token: string,
  number: string,
  text: string,
): Promise<{ ok: boolean; externalId: string | null; error?: string }> {
  const base = process.env.UAZAPI_URL?.replace(/\/$/, "");
  if (!base) return { ok: false, externalId: null, error: "UAZAPI_URL não configurada" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${base}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token },
      body: JSON.stringify({ number, text }),
      signal: controller.signal,
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok)
      return {
        ok: false,
        externalId: null,
        error: body?.error ?? body?.message ?? `HTTP ${res.status}`,
      };
    return { ok: true, externalId: body?.messageid ?? body?.id ?? body?.key?.id ?? null };
  } catch (e: any) {
    return { ok: false, externalId: null, error: e?.name === "AbortError" ? "timeout" : e?.message };
  } finally {
    clearTimeout(timer);
  }
}

async function persistBotMessage(
  sb: any,
  conversationId: string,
  text: string,
  externalId: string | null,
  meta: any,
) {
  await sb.from("messages").insert({
    conversation_id: conversationId,
    direction: "outbound",
    type: "text",
    content: text,
    status: "sent",
    external_id: externalId,
    metadata: { welcome_bot: meta },
  });
  await sb
    .from("conversations")
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: text.slice(0, 120),
    })
    .eq("id", conversationId);
}

function addTag(tags: string[] | null, tag: string): string[] {
  const set = new Set((tags ?? []).map((t) => t.toLowerCase()));
  set.add(tag.toLowerCase());
  return Array.from(set);
}

type MenuOption = {
  id: string;
  position: number;
  keyword: string;
  label: string;
  action_type: "text" | "handoff" | "none";
  response_text: string | null;
  assign_agent_id: string | null;
  assign_tag_id: string | null;
};


async function loadBotConfig(sb: any) {
  const { data: settings } = await sb
    .from("bot_settings")
    .select("enabled, welcome_text")
    .eq("id", 1)
    .maybeSingle();
  if (!settings?.enabled) return null;
  const { data: opts } = await sb
    .from("bot_menu_options")
    .select("id, position, keyword, label, action_type, response_text, assign_agent_id, assign_tag_id")
    .order("position", { ascending: true });

  const options = (opts ?? []) as MenuOption[];
  if (!options.length) return null;
  return { welcomeText: settings.welcome_text as string, options };
}

function buildMenuText(welcome: string, options: MenuOption[]): string {
  const lines = options.map((o) => `${o.keyword} - ${o.label}`);
  return `${welcome}\n\n${lines.join("\n")}`;
}

function matchOption(text: string, options: MenuOption[]): MenuOption | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  // match exato por palavra-chave (permite "1", "2", "menu", "sac", etc.)
  const exact = options.find((o) => o.keyword.trim().toLowerCase() === normalized);
  if (exact) return exact;
  // match por primeiro token (o cliente pode digitar "1 - falar com atendente")
  const firstToken = normalized.split(/\s+/)[0];
  return options.find((o) => o.keyword.trim().toLowerCase() === firstToken) ?? null;
}

// Chamado pelo ingest quando entra uma mensagem inbound.
// - shouldGreet=true → conversa nova ou reativada de FINALIZADO: manda o menu.
// - conversa em modo BOOT (bot_active=true) → tenta casar a escolha e executa.
// - fora dos dois casos, bot fica em silêncio (atendimento humano em andamento).
export async function runWelcomeBot(
  sb: any,
  args: {
    conversationId: string;
    channelId: string;
    phone: string;
    incomingText: string;
    shouldGreet: boolean;
    currentTags: string[] | null;
    botActive: boolean;
    token: string;
  },
) {
  const cfg = await loadBotConfig(sb);
  if (!cfg) return;

  if (args.shouldGreet) {
    const menuText = buildMenuText(cfg.welcomeText, cfg.options);
    const res = await uazapiSendText(args.token, args.phone, menuText);
    if (!res.ok) {
      console.error("[welcome-bot] envio do menu falhou:", res.error);
      return;
    }
    await persistBotMessage(sb, args.conversationId, menuText, res.externalId, { step: "menu" });
    await sb
      .from("conversations")
      .update({
        bot_active: true,
        tags: addTag(args.currentTags, "boot"),
        assigned_agent_id: null,
      })
      .eq("id", args.conversationId);
    return;
  }

  if (!args.botActive) return; // atendimento humano em curso → não intervém

  const choice = matchOption(args.incomingText, cfg.options);
  if (!choice) return; // sem match: bot fica em silêncio, aguarda atendente

  if (choice.action_type === "text" && choice.response_text?.trim()) {
    const res = await uazapiSendText(args.token, args.phone, choice.response_text);
    if (!res.ok) {
      console.error("[welcome-bot] envio da resposta falhou:", res.error);
      return;
    }
    await persistBotMessage(sb, args.conversationId, choice.response_text, res.externalId, {
      step: "option",
      option_id: choice.id,
    });
    // permanece em BOOT — próximas mensagens do cliente ficam em silêncio até
    // o atendente entrar, evitando spam do bot.
    return;
  }

  if (choice.action_type === "handoff") {
    const patch: any = {
      bot_active: false,
      tags: (args.currentTags ?? []).filter((t) => t.toLowerCase() !== "boot"),
      status: "open",
    };
    if (choice.assign_agent_id) patch.assigned_agent_id = choice.assign_agent_id;
    await sb.from("conversations").update(patch).eq("id", args.conversationId);
    return;
  }

  // action_type === "none": só marca escolha, sem responder
  return;
}
