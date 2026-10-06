// Endpoint público de envio para integração externa (agenda de reuniões).
// Autenticado por segredo compartilhado (comparado via hash SHA-256, em tempo
// constante) — não há usuário logado disparando a chamada.
// Disparo simples: não cria conversa/mensagem no banco, apenas envia via uazapi.
import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";

// SHA-256 (hex) do segredo da integração. O valor em texto nunca é armazenado.
const AGENDA_SECRET_SHA256 =
  "b162d595ecfcf3f364b39d2e2b1d8ba97bd768d8c66d22f09e4b42370b18efb2";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function secretMatches(provided: string | null): boolean {
  if (!provided) return false;
  const hash = createHash("sha256").update(provided).digest("hex");
  const a = Buffer.from(hash, "utf8");
  const b = Buffer.from(AGENDA_SECRET_SHA256, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const Route = createFileRoute("/api/public/agenda-send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!secretMatches(request.headers.get("x-agenda-secret"))) {
          return json({ ok: false, error: "unauthorized" }, 401);
        }

        let body: { phone?: string; text?: string; check?: boolean };
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "invalid json body" }, 400);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { uazapiFetch } = await import("@/lib/uazapi.functions");

        const { data: channels, error } = await supabaseAdmin
          .from("channels")
          .select("id, name, identifier, status, credentials")
          .eq("type", "whatsapp");
        if (error) {
          console.error("[agenda-send] erro ao buscar canais:", error.message);
          return json({ ok: false, error: "db error" }, 500);
        }

        const list = (channels ?? []) as any[];
        let channel =
          list.find(
            (c) =>
              typeof c.identifier === "string" &&
              (c.identifier.includes("992904210") || c.identifier.includes("31992904210")),
          ) ?? null;

        if (!channel) {
          const connected = list.filter((c) => c.status === "connected");
          if (connected.length === 1) {
            channel = connected[0];
          } else if (connected.length > 1) {
            return json(
              {
                ok: false,
                error: "multiple connected channels, none matching identifier",
                channels: connected.map((c) => ({
                  id: c.id,
                  name: c.name,
                  identifier: c.identifier,
                  status: c.status,
                })),
              },
              409,
            );
          }
        }

        if (!channel) {
          return json({ ok: false, error: "no whatsapp channel available" }, 404);
        }

        const token = (channel.credentials as any)?.token;
        if (!token) {
          return json({ ok: false, error: "channel without uazapi token" }, 500);
        }

        // Modo verificação: só consulta o status da instância, sem enviar nada.
        if (body.check === true) {
          try {
            const status = await uazapiFetch("/instance/status", { token });
            return json({
              ok: true,
              channel: {
                id: channel.id,
                name: channel.name,
                identifier: channel.identifier,
                status: channel.status,
              },
              uazapi_status: status,
            });
          } catch (e) {
            console.error("[agenda-send] falha no status:", (e as Error).message);
            return json({ ok: false, error: (e as Error).message }, 502);
          }
        }

        if (!body.phone || !body.text) {
          return json({ ok: false, error: "phone and text are required" }, 400);
        }

        let phone = String(body.phone).replace(/\D/g, "");
        if (phone.length === 10 || phone.length === 11) {
          phone = `55${phone}`;
        }

        try {
          const res = await uazapiFetch("/send/text", {
            token,
            body: { number: phone, text: body.text },
          });
          const messageid =
            res?.messageid ?? res?.id ?? res?.key?.id ?? res?.message?.key?.id ?? null;
          console.log(
            `[agenda-send] enviado para ${phone} via canal ${channel.name} (${channel.id}), messageid=${messageid}`,
          );
          return json({ ok: true, messageid, channel: channel.name });
        } catch (e) {
          console.error("[agenda-send] falha no envio:", (e as Error).message);
          return json({ ok: false, error: (e as Error).message }, 502);
        }
      },
    },
  },
});
