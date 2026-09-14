export const AUTHORITATIVE_SUPABASE_PROJECT_ID = 'nrfxhqabwblzxoushgnm';
export const AUTHORITATIVE_SUPABASE_ORIGIN = `https://${AUTHORITATIVE_SUPABASE_PROJECT_ID}.supabase.co`;
export const AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN = `${AUTHORITATIVE_SUPABASE_ORIGIN}/functions/v1`;

// Publishable (client-safe) key of the authoritative user-owned Supabase project.
// Source-declared so an externally injected non-authoritative binding can never
// take over the Preview/frontend runtime.
export const AUTHORITATIVE_SUPABASE_PUBLISHABLE_KEY =
  'sb_publishable_s7QHy6gRiJfwvzj9o1E0ZQ_rt5XDpsr';

function decodeJwtProjectRef(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded =
      typeof atob === 'function'
        ? atob(json)
        : Buffer.from(json, 'base64').toString('utf8');
    const ref = JSON.parse(decoded)?.ref;
    return typeof ref === 'string' ? ref : null;
  } catch {
    return null;
  }
}

// A publishable key is rejected when it demonstrably belongs to another project.
export function publishableKeyMatchesAuthority(key) {
  if (!key) return false;
  const ref = decodeJwtProjectRef(key);
  if (ref === null) return true; // opaque sb_publishable_* keys carry no ref
  return ref === AUTHORITATIVE_SUPABASE_PROJECT_ID;
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
