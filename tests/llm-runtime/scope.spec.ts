import { describe, expect, it } from "vitest";
import { resolveTelemetryScope } from "@/lib/api/llmRuntime.service";

function db(tables: Record<string, { data?: unknown; error?: unknown }>) {
  const builder = (t: string) => {
    const res = tables[t] ?? { data: [] };
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => res,
      then: (fn: any) => Promise.resolve(res).then(fn),
    };
    return chain;
  };
  return { from: (t: string) => builder(t) } as any;
}

describe("llm runtime telemetry scope", () => {
  it("zero memberships + admin role => pre_activation", async () => {
    const s = await resolveTelemetryScope(
      db({ company_membership: { data: [] }, user_roles: { data: [{ role: "admin" }] } }),
      "u1",
    );
    expect(s).toEqual({ ok: true, mode: "pre_activation", companyId: null });
  });

  it("zero memberships + agent role => forbidden", async () => {
    const s = await resolveTelemetryScope(
      db({ company_membership: { data: [] }, user_roles: { data: [{ role: "agent" }] } }),
      "u1",
    );
    expect(s).toEqual({ ok: false, error: "forbidden" });
  });

  it("inactive membership => not_a_member (never pre_activation)", async () => {
    const s = await resolveTelemetryScope(
      db({
        company_membership: { data: [{ company_id: "c1", role: "admin", is_active: false }] },
        user_roles: { data: [{ role: "admin" }] },
      }),
      "u1",
    );
    expect(s).toEqual({ ok: false, error: "not_a_member" });
  });

  it("active membership + active company => canonical", async () => {
    const s = await resolveTelemetryScope(
      db({
        company_membership: { data: [{ company_id: "c1", role: "admin", is_active: true }] },
        company: { data: { id: "c1", is_active: true } },
      }),
      "u1",
    );
    expect(s).toEqual({ ok: true, mode: "canonical", companyId: "c1" });
  });

  it("inactive company => company_inactive", async () => {
    const s = await resolveTelemetryScope(
      db({
        company_membership: { data: [{ company_id: "c1", role: "admin", is_active: true }] },
        company: { data: { id: "c1", is_active: false } },
      }),
      "u1",
    );
    expect(s).toEqual({ ok: false, error: "company_inactive" });
  });

  it("multi-company identity => ambiguous", async () => {
    const s = await resolveTelemetryScope(
      db({
        company_membership: {
          data: [
            { company_id: "c1", role: "admin", is_active: true },
            { company_id: "c2", role: "admin", is_active: true },
          ],
        },
      }),
      "u1",
    );
    expect(s).toEqual({ ok: false, error: "company_membership_ambiguous" });
  });
});
