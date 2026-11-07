// Isolated Vite dev alias ONLY. This module is never used by a production build.
const url = import.meta.env.VITE_C3_LOCAL_SUPABASE_URL;
const key = import.meta.env.VITE_C3_LOCAL_SUPABASE_ANON_KEY;
if (!url || !/^http:\/\/(?:127\.0\.0\.1|localhost):54321$/.test(url) || !key) {
  throw new Error("C3 isolated Auth requires loopback Supabase and a local anon key");
}
export const AUTHORITATIVE_SUPABASE_ORIGIN = url;
export const AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN = `${url}/functions/v1`;
export const AUTHORITATIVE_SUPABASE_PROJECT_ID = "c3-local-isolated";
export const AUTHORITATIVE_SUPABASE_PUBLISHABLE_KEY = key;
export function resolveAuthoritativeSupabaseBinding() {
  return { url, projectId: AUTHORITATIVE_SUPABASE_PROJECT_ID,
    publishableKey: key, functionsUrl: AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN };
}
export function assertAuthoritativeSupabaseRuntime(input) {
  if (input !== url) throw new Error("C3 isolated Auth origin drift");
  return true;
}
export function assertAuthoritativeFunctionsRuntime(input) {
  if (input !== AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN) throw new Error("C3 isolated Functions origin drift");
  return true;
}
export function authoritativeFunctionsBase(input) {
  assertAuthoritativeFunctionsRuntime(input || AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN);
  return AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN;
}
