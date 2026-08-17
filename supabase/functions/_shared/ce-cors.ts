const ALLOWED_ORIGIN = "https://console-chat-hub.lovable.app";
const PROJECT_ID = "4dbf593e-577e-4af4-a553-460441c34473";
const PROJECT_HOST = `${PROJECT_ID}.lovableproject.com`;
const PROJECT_PREVIEW_HOST = `${PROJECT_ID}.lovable.app`;

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

export function ceCorsHeaders(origin: string): Record<string, string> {
  const allow = isAllowedCeOrigin(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    Vary: "Origin",
  };
}
