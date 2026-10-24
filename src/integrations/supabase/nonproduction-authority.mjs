// Selected only by the server-controlled C3_CONSOLE_ENV build/dev configuration.
// Fixed allowlisted identity: no query, storage, request, or client env can select a backend.
export const AUTHORITATIVE_SUPABASE_PROJECT_ID = "nbtowfuvvfqpxqydyoby";
export const AUTHORITATIVE_SUPABASE_ORIGIN = `https://${AUTHORITATIVE_SUPABASE_PROJECT_ID}.supabase.co`;
export const AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN = `${AUTHORITATIVE_SUPABASE_ORIGIN}/functions/v1`;
export const AUTHORITATIVE_SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_UdDIKm0xiB1o1jy-ymD_hA_-ZfUXx0i";
export function resolveAuthoritativeSupabaseBinding() {
  return {
    url: AUTHORITATIVE_SUPABASE_ORIGIN,
    projectId: AUTHORITATIVE_SUPABASE_PROJECT_ID,
    publishableKey: AUTHORITATIVE_SUPABASE_PUBLISHABLE_KEY,
    functionsUrl: AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN,
  };
}
export function assertAuthoritativeSupabaseRuntime(url, projectId) {
  if (
    url !== AUTHORITATIVE_SUPABASE_ORIGIN ||
    (projectId && projectId !== AUTHORITATIVE_SUPABASE_PROJECT_ID)
  ) {
    throw new Error("[Supabase] Nonproduction Console authority drift");
  }
  return true;
}
export function assertAuthoritativeFunctionsRuntime(url) {
  if (url !== AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN)
    throw new Error("[Supabase] Nonproduction Functions authority drift");
  return true;
}
export function authoritativeFunctionsBase(url) {
  assertAuthoritativeFunctionsRuntime(url || AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN);
  return AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN;
}
export function publishableKeyMatchesAuthority(key) {
  return key === AUTHORITATIVE_SUPABASE_PUBLISHABLE_KEY;
}
