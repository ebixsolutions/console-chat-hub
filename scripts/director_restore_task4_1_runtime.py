from pathlib import Path

p = Path("supabase/functions/generate-reply/index.ts")
s = p.read_text()

anchor = 'type SupabaseAdminClient = SupabaseClient<any, "public", any>;\n'
adapter = '''type SupabaseAdminClient = SupabaseClient<any, "public", any>;

// Current-main escalation-live.ts intentionally exposes a narrow Promise-shaped
// RPC contract. Supabase-js returns an awaitable Postgrest builder. Normalize that
// boundary once so the frozen escalation semantics/RPC names remain unchanged.
function requiredEscalationRpcClient(client: SupabaseAdminClient) {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const { data, error } = await client.rpc(fn, args as any);
      const payload: Record<string, unknown> | null =
        data == null
          ? null
          : (typeof data === "object" && !Array.isArray(data)
            ? data as Record<string, unknown>
            : { result: data });
      return {
        data: payload,
        error: error ? { message: String(error.message ?? "rpc_error") } : null,
      };
    },
  };
}
'''

if "function requiredEscalationRpcClient(" not in s:
    count = s.count(anchor)
    if count != 1:
        raise SystemExit(f"expected one SupabaseAdminClient anchor, got {count}")
    s = s.replace(anchor, adapter, 1)

pairs = [
    (
        "persistRequiredEscalationClarification(supabaseAdmin, {",
        "persistRequiredEscalationClarification(requiredEscalationRpcClient(supabaseAdmin), {",
    ),
    (
        "persistRequiredEscalationHandoff(supabaseAdmin, {",
        "persistRequiredEscalationHandoff(requiredEscalationRpcClient(supabaseAdmin), {",
    ),
]

for old, new in pairs:
    if new in s:
        continue
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"expected one callsite for {old}, got {count}")
    s = s.replace(old, new, 1)

if s.count("requiredEscalationRpcClient(supabaseAdmin)") != 2:
    raise SystemExit("both required escalation callsites were not normalized")

p.write_text(s)
print("DIRECTOR_TASK4_1_RPC_COMPAT=PASS")
