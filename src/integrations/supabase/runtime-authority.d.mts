export const AUTHORITATIVE_SUPABASE_PROJECT_ID: string;
export const AUTHORITATIVE_SUPABASE_ORIGIN: string;
export const AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN: string;
export const AUTHORITATIVE_SUPABASE_PUBLISHABLE_KEY: string;

export function assertAuthoritativeSupabaseRuntime(
  url: string | undefined,
  projectId?: string | undefined,
): boolean;

export function assertAuthoritativeFunctionsRuntime(url: string | undefined): boolean;

export function authoritativeFunctionsBase(configuredUrl?: string | undefined): string;

export function publishableKeyMatchesAuthority(key: string | undefined | null): boolean;

export function resolveAuthoritativeSupabaseBinding(env?: {
  url?: string | undefined;
  projectId?: string | undefined;
  publishableKey?: string | undefined;
  functionsUrl?: string | undefined;
}): {
  url: string;
  projectId: string;
  publishableKey: string;
  functionsUrl: string;
};
