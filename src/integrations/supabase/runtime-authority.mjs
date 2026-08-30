export const AUTHORITATIVE_SUPABASE_PROJECT_ID = 'nrfxhqabwblzxoushgnm';
export const AUTHORITATIVE_SUPABASE_ORIGIN = `https://${AUTHORITATIVE_SUPABASE_PROJECT_ID}.supabase.co`;

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
