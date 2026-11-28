export const AUTHORITATIVE_SUPABASE_PROJECT_ID = 'nrfxhqabwblzxoushgnm';
export const AUTHORITATIVE_SUPABASE_ORIGIN = `https://${AUTHORITATIVE_SUPABASE_PROJECT_ID}.supabase.co`;
export const AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN = `${AUTHORITATIVE_SUPABASE_ORIGIN}/functions/v1`;

// Publishable (client-safe) key of the authoritative user-owned Supabase project.
// Source-declared so an externally injected non-authoritative binding can never
// take over the Preview/frontend runtime.
export const AUTHORITATIVE_SUPABASE_PUBLISHABLE_KEY =
  'sb_publishable_s7QHy6gRiJfwvzj9o1E0ZQ_rt5XDpsr';

// Opaque publishable keys have no verifiable project ref. Only the source-declared
// canonical public key may replace the fallback; malformed or injected keys cannot.
export function publishableKeyMatchesAuthority(key) {
  return key === AUTHORITATIVE_SUPABASE_PUBLISHABLE_KEY;
}

// Single source of truth for every Preview/frontend + SSR Supabase binding.
// Environment values are accepted only when they already resolve to the
// authoritative project; otherwise the authoritative source values are used.
export function resolveAuthoritativeSupabaseBinding(env = {}) {
  const publishableKey = publishableKeyMatchesAuthority(env.publishableKey)
    ? env.publishableKey
    : AUTHORITATIVE_SUPABASE_PUBLISHABLE_KEY;

  let functionsUrl = AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN;
  if (env.functionsUrl) {
    try {
      assertAuthoritativeFunctionsRuntime(env.functionsUrl);
      functionsUrl = env.functionsUrl.replace(/\/+$/, '');
    } catch {
      functionsUrl = AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN;
    }
  }

  return {
    url: AUTHORITATIVE_SUPABASE_ORIGIN,
    projectId: AUTHORITATIVE_SUPABASE_PROJECT_ID,
    publishableKey,
    functionsUrl,
  };
}

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
