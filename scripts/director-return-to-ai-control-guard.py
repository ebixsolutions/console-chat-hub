from pathlib import Path

root = Path('.')
shared = root / 'supabase/functions/_shared/return-to-ai-control.ts'
shared.write_text('''export const RETURN_TO_AI_CONTROL_GUARD_VERSION = "return-to-ai-control-v1" as const;\n\nexport function buildReturnToAiGenerationGuard(\n  latestHandoffReason: string | null | undefined,\n  assignedAgentId: string | null | undefined,\n): string {\n  const reason = String(latestHandoffReason ?? "").trim().toLowerCase();\n  if (reason !== "return to ai" || assignedAgentId) return "";\n  return [\n    "Conversation control state: AI_ACTIVE_AFTER_EXPLICIT_RETURN_TO_AI.",\n    "- The conversation was explicitly returned from human control to AI control.",\n    "- Do NOT tell the customer that a human agent will reply, contact them, take over, or follow up unless the CURRENT visitor turn independently triggers a new governed handoff.",\n    "- Historical handoff messages are past state only; do not continue or restate them as current status.",\n    "- Continue the current customer conversation normally under AI control.",\n  ].join("\\n");\n}\n''')

p = root / 'supabase/functions/generate-reply/index.ts'
s = p.read_text()
imp = 'import { buildReturnToAiGenerationGuard } from "../_shared/return-to-ai-control.ts";\n'
anchor = 'import { buildMissingFactsQuestion, buildWarmHandoffPackage } from "../_shared/warm-handoff.ts";\n'
if imp not in s:
    assert anchor in s
    s = s.replace(anchor, imp + anchor, 1)

helper = '''\nasync function loadLatestHandoffReason(\n  supabaseAdmin: SupabaseAdminClient,\n  conversationId: string,\n): Promise<string | null> {\n  const { data, error } = await supabaseAdmin\n    .from("handoff_event")\n    .select("handoff_reason, created_at")\n    .eq("conversation_id", conversationId)\n    .order("created_at", { ascending: false })\n    .limit(1)\n    .maybeSingle();\n  if (error) {\n    console.error("[generate-reply] latest handoff control lookup failed (non-blocking):", conversationId);\n    return null;\n  }\n  return typeof data?.handoff_reason === "string" ? data.handoff_reason : null;\n}\n'''
if 'async function loadLatestHandoffReason(' not in s:
    helper_anchor = 'function routerFailureToS0(code: LlmFailureCode): string {'
    idx = s.index(helper_anchor)
    s = s[:idx] + helper + '\n' + s[idx:]

legacy_marker = '  const legacySystemPrompt = `You are a professional and friendly customer service assistant.\n'
if 'const legacyReturnToAiGuard = buildReturnToAiGenerationGuard(' not in s:
    assert legacy_marker in s
    legacy_pre = '''  const legacyLatestHandoffReason = await loadLatestHandoffReason(supabaseAdmin, conversation_id);\n  const legacyReturnToAiGuard = buildReturnToAiGenerationGuard(\n    legacyLatestHandoffReason,\n    conversation.assigned_agent_id ?? null,\n  );\n\n'''
    s = s.replace(legacy_marker, legacy_pre + legacy_marker, 1)
    legacy_policy = '\n${CUSTOMER_CONVERSATION_POLICY}`;'
    assert legacy_policy in s
    s = s.replace(legacy_policy, '\n${CUSTOMER_CONVERSATION_POLICY}\n\n${legacyReturnToAiGuard}`;', 1)

orch_marker = '  const finalSystemPrompt = _priorGroundedTransform\n'
if 'const returnToAiGuard = buildReturnToAiGenerationGuard(' not in s:
    assert orch_marker in s
    orch_pre = '''  const latestHandoffReason = await loadLatestHandoffReason(supabaseAdmin, conversation_id);\n  const returnToAiGuard = buildReturnToAiGenerationGuard(\n    latestHandoffReason,\n    conversation.assigned_agent_id ?? null,\n  );\n'''
    s = s.replace(orch_marker, orch_pre + orch_marker, 1)
    list_anchor = '''        _conversationContinuityBlock,\n        _customerAdvisoryBlock,\n'''
    assert list_anchor in s
    s = s.replace(list_anchor, '''        _conversationContinuityBlock,\n        returnToAiGuard,\n        _customerAdvisoryBlock,\n''', 1)

p.write_text(s)

test = root / 'tests/edge/return-to-ai-control-context.test.ts'
test.write_text('''import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";\nimport { buildReturnToAiGenerationGuard } from "../../supabase/functions/_shared/return-to-ai-control.ts";\n\nDeno.test("Return-to-AI guard activates only after explicit return and no human owner", () => {\n  const guard = buildReturnToAiGenerationGuard("Return to AI", null);\n  assertStringIncludes(guard, "AI_ACTIVE_AFTER_EXPLICIT_RETURN_TO_AI");\n  assertStringIncludes(guard, "CURRENT visitor turn");\n});\n\nDeno.test("Return-to-AI guard is absent while human owner remains", () => {\n  assertEquals(buildReturnToAiGenerationGuard("Return to AI", "agent-1"), "");\n});\n\nDeno.test("historical takeover or R1 event does not masquerade as Return-to-AI", () => {\n  assertEquals(buildReturnToAiGenerationGuard("Agent takeover", null), "");\n  assertEquals(buildReturnToAiGenerationGuard("Visitor explicitly requested human agent (R1)", null), "");\n});\n''')
