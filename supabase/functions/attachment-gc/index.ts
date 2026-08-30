import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";
import { json } from "../_shared/cors.ts";

const BUCKET = "widget-attachments";
const BATCH_SIZE = 100;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, getSupabaseAdminKey());
    const { data: rows, error: lookupError } = await supabase
      .from("attachment_delete_outbox")
      .select("id,storage_bucket,storage_path,attempts")
      .is("processed_at", null)
      .order("queued_at", { ascending: true })
      .limit(BATCH_SIZE);
    if (lookupError) return json({ success: false, error: "outbox_lookup_failed" }, 500);

    let processed = 0;
    let failed = 0;
    for (const row of rows ?? []) {
      const id = String(row.id);
      const bucket = String(row.storage_bucket ?? "");
      const path = String(row.storage_path ?? "");
      if (bucket !== BUCKET || !path) {
        await supabase.from("attachment_delete_outbox").update({
          attempts: Number(row.attempts ?? 0) + 1,
          last_error: "invalid_locator",
        }).eq("id", id);
        failed++;
        continue;
      }

      const { error: removeError } = await supabase.storage.from(BUCKET).remove([path]);
      if (removeError) {
        await supabase.from("attachment_delete_outbox").update({
          attempts: Number(row.attempts ?? 0) + 1,
          last_error: "storage_remove_failed",
        }).eq("id", id);
        failed++;
        continue;
      }

      const { error: updateError } = await supabase.from("attachment_delete_outbox").update({
        processed_at: new Date().toISOString(),
        attempts: Number(row.attempts ?? 0) + 1,
        last_error: null,
      }).eq("id", id);
      if (updateError) {
        failed++;
        continue;
      }
      processed++;
    }

    return json({ success: true, processed, failed, scanned: (rows ?? []).length });
  } catch (e) {
    console.error("[attachment-gc] unexpected", e instanceof Error ? e.name : "unknown");
    return json({ success: false, error: "internal_error" }, 500);
  }
});
