export const AUTHORITATIVE_SUPABASE_PROJECT_ID = 'nrfxhqabwblzxoushgnm';
export const AUTHORITATIVE_SUPABASE_ORIGIN = `https://${AUTHORITATIVE_SUPABASE_PROJECT_ID}.supabase.co`;
export const AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN = `${AUTHORITATIVE_SUPABASE_ORIGIN}/functions/v1`;

export function assertAuthoritativeSupabaseRuntime(url, projectId) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new Error('[Supabase] Invalid Supabase runtime URL.');
  }

  if (origin !== AUTHORITATIVE_SUPABASE_ORIGIN) {
    throw new Error('[Supabase] Refusing non-authoritative Supabase backend runtime.');
  }
  if (projectId && projectId !== AUTHORITATIVE_SUPABASE_PROJECT_ID) {
    throw new Error('[Supabase] Refusing non-authoritative Supabase project binding.');
  }

  return true;
}

export function assertAuthoritativeFunctionsRuntime(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('[Supabase] Invalid Edge Functions runtime URL.');
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  if (
    parsed.origin !== AUTHORITATIVE_SUPABASE_ORIGIN ||
    normalizedPath !== '/functions/v1'
  ) {
    throw new Error('[Supabase] Refusing non-authoritative Edge Functions runtime.');
  }

  return true;
}

export function authoritativeFunctionsBase(configuredUrl) {
  const candidate = configuredUrl || AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN;
  assertAuthoritativeFunctionsRuntime(candidate);
  return candidate.replace(/\/+$/, '');
}
