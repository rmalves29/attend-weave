// Processa follow-ups agendados pelas tags (ex: "aguardando" → mensagem em 24h).
// Chamado de carona nos webhooks da uazapi (tráfego frequente garante a
// pontualidade sem precisar de cron externo). Idempotente: cada follow-up é
// "reivindicado" (pending → sending) antes de enviar, evitando envio duplo
// quando dois webhooks chegam juntos.

async function uazapiSendText(token: string, number: string, text: string): Promise<{ ok: boolean; externalId: string | null; error?: string }> {
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
    if (!res.ok) return { ok: false, externalId: null, error: body?.error ?? body?.message ?? `HTTP ${res.status}` };
    return { ok: true, externalId: body?.messageid ?? body?.id ?? body?.key?.id ?? null };
  } catch (e: any) {
    return { ok: false, externalId: null, error: e?.name === "AbortError" ? "timeout" : e?.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function processDueFollowups(supabaseAdmin: any, limit = 3): Promise<number> {
  const { data: due } = await supabaseAdmin
    .from("tag_followups")
    .select("id, conversation_id, tag_id")
    .eq("status", "pending")
    .lte("send_at", new Date().toISOString())
    .order("send_at", { ascending: true })
    .limit(limit);
  if (!due?.length) return 0;

  let sent = 0;
  for (const fu of due) {
    // claim atômico — se outra execução pegou primeiro, pula
    const { data: claimed } = await supabaseAdmin
      .from("tag_followups")
      .update({ status: "sending" })
      .eq("id", fu.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    try {
      const { data: tag } = await supabaseAdmin
        .from("tags").select("name, auto_message_content, auto_message_enabled")
        .eq("id", fu.tag_id).single();
      const { data: conv } = await supabaseAdmin
        .from("conversations")
        .select("id, contact_id, channel_id, contacts(phone), channels(credentials)")
        .eq("id", fu.conversation_id).single();

      const content = tag?.auto_message_content?.trim();
      const phone = (conv as any)?.contacts?.phone;
      const token = ((conv as any)?.channels?.credentials as any)?.token;

      if (!tag?.auto_message_enabled || !content || !phone || !token) {
        await supabaseAdmin.from("tag_followups").update({ status: "cancelled" }).eq("id", fu.id);
        continue;
      }

      const res = await uazapiSendText(token, phone, content);
      if (!res.ok) {
        console.error(`[followups] envio falhou (${fu.id}): ${res.error} — reagendando +30min`);
        await supabaseAdmin.from("tag_followups").update({
          status: "pending",
          send_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        }).eq("id", fu.id);
        continue;
      }

      await supabaseAdmin.from("messages").insert({
        conversation_id: fu.conversation_id,
        direction: "outbound",
        type: "text",
        content,
        status: "sent",
        external_id: res.externalId,
        metadata: { auto_followup: { tag: tag.name, followup_id: fu.id }, automated: true },
      });
      await supabaseAdmin.from("conversations").update({
        last_message_at: new Date().toISOString(),
        last_message_preview: content.slice(0, 120),
      }).eq("id", fu.conversation_id);
      await supabaseAdmin.from("tag_followups").update({ status: "sent" }).eq("id", fu.id);
      console.log(`[followups] ✅ enviado follow-up '${tag.name}' → ${phone}`);
      sent++;
    } catch (e) {
      console.error("[followups] erro:", (e as Error).message);
      await supabaseAdmin.from("tag_followups").update({
        status: "pending",
        send_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }).eq("id", fu.id);
    }
  }
  return sent;
}
