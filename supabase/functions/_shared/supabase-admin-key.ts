export function getSupabaseAdminKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEY")?.trim() ?? "";
  if (modern) return modern;

  // Transitional compatibility for previously deployed Supabase Edge bundles.
  // New external/server hosting must inject SUPABASE_SECRET_KEY (singular).
  const legacyJson = Deno.env.get("SUPABASE_SECRET_KEYS")?.trim();
  if (legacyJson) {
    try {
      const parsed = JSON.parse(legacyJson);
      const key = parsed && typeof parsed === "object"
        ? String(parsed.default ?? "").trim()
        : "";
      if (key) return key;
    } catch {
      // Fall through to Supabase's built-in service role secret.
    }
  }

  // Supabase Edge Runtime provides this server-only secret. It is never returned
  // to the browser and remains a safe in-platform fallback during secret cutover.
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (serviceRole) return serviceRole;

  throw new Error("SUPABASE_ADMIN_KEY_MISSING");
}
