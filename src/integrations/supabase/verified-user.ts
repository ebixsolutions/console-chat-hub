/** Verify a client session against the authoritative project's Auth service. */
export async function verifiedSupabaseUserId(
  auth: {
    getUser(token: string): Promise<{
      data: { user: { id: string } | null } | null;
      error: unknown;
    }>;
  },
  token: string,
): Promise<string> {
  if (!token) throw new Error("Unauthorized: No token provided");
  const { data, error } = await auth.getUser(token);
  if (error || !data?.user?.id) throw new Error("Unauthorized: Invalid token");
  return data.user.id;
}
