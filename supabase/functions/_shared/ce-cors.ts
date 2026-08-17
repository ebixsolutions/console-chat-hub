const ALLOWED_ORIGIN = "https://console-chat-hub.lovable.app";
const PROJECT_ID = "4dbf593e-577e-4af4-a553-460441c34473";
const PROJECT_HOST = `${PROJECT_ID}.lovableproject.com`;
const PROJECT_PREVIEW_HOST = `${PROJECT_ID}.lovable.app`;

const ALLOWED_REQUEST_HEADERS = new Set([
  "authorization",
  "apikey",
  "content-type",
  "x-client-info",
  "x-supabase-api-version",
]);

export function isAllowedCeOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:") return false;
    if (origin === ALLOWED_ORIGIN) return true;

    const host = u.hostname.toLowerCase();
    return (
      host === PROJECT_HOST ||
      host.endsWith(`--${PROJECT_HOST}`) ||
      host === PROJECT_PREVIEW_HOST ||
      host.endsWith(`--${PROJECT_PREVIEW_HOST}`)
    );
  } catch {
    return false;
  }
}

export function resolveCeAllowedHeaders(requestedHeaders: string): string {
  const requested = requestedHeaders
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  if (requested.some((h) => !ALLOWED_REQUEST_HEADERS.has(h))) return "";

  const unique = [...new Set(requested)];
  return unique.join(", ");
}

export function ceCorsHeaders(
  origin: string,
  requestedHeaders = "",
): Record<string, string> {
  const allowOrigin = isAllowedCeOrigin(origin) ? origin : "";
  const allowHeaders = requestedHeaders
    ? resolveCeAllowedHeaders(requestedHeaders)
    : [...ALLOWED_REQUEST_HEADERS].join(", ");

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": allowHeaders,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    Vary: "Origin, Access-Control-Request-Headers",
  };
}
