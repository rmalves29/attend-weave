// Admin-only user management: cria novos usuários (admin ou atendente) com
// senha e role já definidos. Requer que o chamador seja admin.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const createUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      name: z.string().trim().min(2).max(80),
      email: z.string().trim().email().max(255),
      password: z.string().min(8).max(72),
      role: z.enum(["admin", "agent"]),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    // só admin pode criar usuários
    const { data: isAdmin, error: roleErr } = await context.supabase
      .rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Apenas administradores podem criar usuários.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // cria no auth já confirmado; trigger handle_new_user cria profile + role 'agent'
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { name: data.name },
    });
    if (error || !created.user) throw new Error(error?.message ?? "Falha ao criar usuário");

    // se pedido for admin, adiciona o papel admin (agent já foi criado pelo trigger)
    if (data.role === "admin") {
      const { error: rErr } = await supabaseAdmin
        .from("user_roles")
        .insert({ user_id: created.user.id, role: "admin" });
      // ignora conflito de unicidade
      if (rErr && !String(rErr.message).includes("duplicate")) {
        throw new Error(rErr.message);
      }
    }

    return { ok: true, userId: created.user.id };
  });
