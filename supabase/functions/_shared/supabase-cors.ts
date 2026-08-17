const SUPABASE_BROWSER_HEADERS = new Set([
  "authorization",
  "x-client-info",
  "apikey",
  "content-type",
  "x-supabase-api-version",
]);

export function resolveSupabaseAllowedHeaders(requestedHeaders: string): string {
  const requested = requestedHeaders.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!requested.length) return [...SUPABASE_BROWSER_HEADERS].join(", ");
  if (requested.some((h) => !SUPABASE_BROWSER_HEADERS.has(h))) return "";
  return [...new Set(requested)].join(", ");
}

export function supabaseCorsHeaders(
  origin: string,
  allowedOrigins: readonly string[],
  requestedHeaders = "",
): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigins.includes(origin) ? origin : "",
    "Access-Control-Allow-Headers": resolveSupabaseAllowedHeaders(requestedHeaders),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin, Access-Control-Request-Headers",
  };
}
