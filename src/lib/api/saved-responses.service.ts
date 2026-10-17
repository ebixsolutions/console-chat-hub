import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { readInboxConversations } from "@/lib/api/inbox-read";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
export type SavedResponse = { id: string; title: string; content: string; revision: number };
const input = z.object({
  action: z.enum(["list", "save", "delete"]),
  id: z.string().uuid().optional(),
  revision: z.number().int().min(1).optional(),
  create_id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(100).optional(),
  content: z.string().trim().min(1).max(4000).optional(),
});
export async function savedResponseOperation(
  db: SupabaseClient<Database>,
  userId: string,
  data: z.infer<typeof input>,
) {
  // Normal user client and RLS remain in force; never use service-role here.
  const { data: memberships, error: me } = await db
    .from("company_membership")
    .select("company_id,role")
    .eq("user_id", userId)
    .eq("is_active", true);
  const companies = [...new Set((memberships ?? []).map((m) => m.company_id))];
  if (
    me ||
    companies.length !== 1 ||
    !(memberships ?? []).some((m) => ["admin", "supervisor", "agent"].includes(m.role))
  )
    return { ok: false as const, error: "saved_response_scope_denied" };
  const companyId = companies[0];
  const { data: company, error: ce } = await db
    .from("company")
    .select("id,is_active")
    .eq("id", companyId)
    .maybeSingle();
  if (ce || !company?.is_active)
    return { ok: false as const, error: "saved_response_scope_denied" };
  const columns = "id,title,content,revision";
  if (data.action === "list") {
    const result = await readInboxConversations((from, to) =>
      db
        .from("saved_response")
        .select(columns, { count: "exact" })
        .eq("company_id", companyId)
        .eq("owner_id", userId)
        .order("title")
        .order("id")
        .range(from, to),
    );
    return result.error
      ? { ok: false as const, error: result.error.message }
      : { ok: true as const, rows: result.data as SavedResponse[] };
  }
  if (data.action === "delete") {
    if (!data.id || !data.revision)
      return { ok: false as const, error: "saved_response_revision_required" };
    const { data: rows, error } = await db
      .from("saved_response")
      .delete()
      .eq("id", data.id)
      .eq("company_id", companyId)
      .eq("owner_id", userId)
      .eq("revision", data.revision)
      .select(columns);
    return error
      ? { ok: false as const, error: "saved_response_delete_failed" }
      : rows?.length !== 1
        ? { ok: false as const, error: "saved_response_conflict_refresh" }
        : { ok: true as const, rows: [] as SavedResponse[] };
  }
  if (!data.title || !data.content)
    return { ok: false as const, error: "saved_response_content_required" };
  if (!data.id && !data.create_id)
    return { ok: false as const, error: "saved_response_request_id_required" };
  const result = data.id
    ? data.revision
      ? await db
          .from("saved_response")
          .update({ title: data.title, content: data.content, revision: data.revision + 1 })
          .eq("id", data.id)
          .eq("company_id", companyId)
          .eq("owner_id", userId)
          .eq("revision", data.revision)
          .select(columns)
      : { data: null, error: { message: "revision_required", code: "revision_required" } }
    : await db
        .from("saved_response")
        .insert({
          id: data.create_id,
          company_id: companyId,
          owner_id: userId,
          title: data.title,
          content: data.content,
        })
        .select(columns);
  if (!data.id && result.error?.code === "23505") {
    const existing = await db
      .from("saved_response")
      .select(columns)
      .eq("id", data.create_id!)
      .eq("company_id", companyId)
      .eq("owner_id", userId)
      .maybeSingle();
    if (
      !existing.error &&
      existing.data?.title === data.title &&
      existing.data?.content === data.content &&
      existing.data?.revision === 1
    )
      return { ok: true as const, rows: [existing.data as SavedResponse] };
  }
  return result.error
    ? { ok: false as const, error: "saved_response_save_failed" }
    : result.data?.length !== 1
      ? { ok: false as const, error: "saved_response_conflict_refresh" }
      : { ok: true as const, rows: result.data as SavedResponse[] };
}
export const savedResponsesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(input)
  .handler(({ data, context }) =>
    savedResponseOperation(context.supabase, String(context.userId), data),
  );
export const savedResponsesService = {
  run: (data: z.infer<typeof input>) => savedResponsesFn({ data }),
};
