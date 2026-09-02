import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ACTIVE_THINKING_MAX_AGE_MS,
  hasActiveThinkingClaim,
  isHumanControlState,
} from "../../supabase/functions/_shared/widget-runtime-state.ts";

Deno.test("all canonical human-control statuses stop AI widget state", () => {
  for (const status of ["pending","transferred","human_needed","human_control","escalation_risk","unresolved"]) {
    assertEquals(isHumanControlState(status, null), true, status);
  }
  assertEquals(isHumanControlState("open", null), false);
  assertEquals(isHumanControlState("open", "agent-1"), true);
});

Deno.test("current lineage-bound thinking claim is active", () => {
  const now = Date.parse("2026-09-02T06:00:00Z");
  assertEquals(hasActiveThinkingClaim([{
    created_at: new Date(now - 30_000).toISOString(),
    metadata: { source_message_id: "11111111-1111-1111-1111-111111111111" },
  }], now), true);
});

Deno.test("legacy thinking sentinel without source lineage is ignored", () => {
  const now = Date.parse("2026-09-02T06:00:00Z");
  assertEquals(hasActiveThinkingClaim([{ created_at: new Date(now - 30_000).toISOString(), metadata: {} }], now), false);
});

Deno.test("stale thinking claim cannot keep customer spinner alive forever", () => {
  const now = Date.parse("2026-09-02T06:00:00Z");
  assertEquals(hasActiveThinkingClaim([{
    created_at: new Date(now - ACTIVE_THINKING_MAX_AGE_MS - 1).toISOString(),
    metadata: { source_message_id: "11111111-1111-1111-1111-111111111111" },
  }], now), false);
});

Deno.test("future or malformed thinking claims are ignored", () => {
  const now = Date.parse("2026-09-02T06:00:00Z");
  assertEquals(hasActiveThinkingClaim([{
    created_at: new Date(now + 1_000).toISOString(),
    metadata: { source_message_id: "11111111-1111-1111-1111-111111111111" },
  }], now), false);
  assertEquals(hasActiveThinkingClaim([{ created_at: "bad", metadata: { source_message_id: "bad" } }], now), false);
});
