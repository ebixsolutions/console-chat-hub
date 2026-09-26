import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getSupabaseAdminKey } from "./supabase-admin-key.ts";

const NONPRODUCTION_REF = "nbtowfuvvfqpxqydyoby";

export function isC3NonproductionProject(): boolean {
  try {
    return new URL(Deno.env.get("SUPABASE_URL") ?? "").hostname ===
      `${NONPRODUCTION_REF}.supabase.co`;
  } catch {
    return false;
  }
}
export async function resolveServerSecret(
  environmentName: string,
  nonproductionVaultName: string,
): Promise<string | null> {
  const configured = Deno.env.get(environmentName)?.trim();
  if (configured) return configured;
  if (!isC3NonproductionProject()) return null;
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  let key = "";
  try {
    key = getSupabaseAdminKey();
  } catch {
    return null;
  }
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.rpc("c3_nonprod_resolve_secret", {
    p_name: nonproductionVaultName,
  });
  return !error && typeof data === "string" && data.trim() ? data.trim() : null;
}
