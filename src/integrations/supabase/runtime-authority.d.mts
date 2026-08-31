export const AUTHORITATIVE_SUPABASE_PROJECT_ID: string;
export const AUTHORITATIVE_SUPABASE_ORIGIN: string;
export const AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN: string;

export function assertAuthoritativeSupabaseRuntime(
  url: string | undefined,
  projectId?: string | undefined,
): boolean;

export function assertAuthoritativeFunctionsRuntime(url: string | undefined): boolean;

export function authoritativeFunctionsBase(configuredUrl?: string | undefined): string;
