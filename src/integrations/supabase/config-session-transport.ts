export type ConfigSessionAuth = {
  getSession(): Promise<{
    data: { session: { access_token: string } | null };
    error: unknown;
  }>;
};

/** Fetch a browser session once; Supabase refreshes an expired session here. */
export async function withConfigSession<T>(
  auth: ConfigSessionAuth,
  invoke: (headers: HeadersInit) => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  const { data, error } = await auth.getSession();
  if (error || !data.session?.access_token) {
    return { ok: false, error: "Unauthorized: No active session" };
  }
  return invoke({ Authorization: `Bearer ${data.session.access_token}` });
}
