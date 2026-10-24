import type { ServerCustomerContext } from "./conversation-service-runtime.ts";
import { resolveServerSecret } from "./nonproduction-secret.ts";
import { validateTrustedCustomerContext } from "./customer360-entitlement-contract.ts";
export { validateTrustedCustomerContext } from "./customer360-entitlement-contract.ts";

export async function fetchTrustedCustomerContext(input: {
  conversation_id: string;
  company_id: string;
  timeout_ms?: number;
}): Promise<ServerCustomerContext | null> {
  const url = Deno.env.get("SUPABASE_URL")?.replace(/\/+$/, "");
  const token = await resolveServerSecret(
    "CUSTOMER360_INTERNAL_TOKEN",
    "c3_customer360_internal_token",
  );
  if (!url || !token) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeout_ms ?? 5000);
  try {
    const response = await fetch(`${url}/functions/v1/customer360-adapter`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Service-Token": token,
      },
      body: JSON.stringify({ conversation_id: input.conversation_id }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return validateTrustedCustomerContext(await response.json(), input);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
