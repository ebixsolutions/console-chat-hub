from pathlib import Path

runtime = Path('supabase/functions/_shared/commerce-state-runtime.ts')
index = Path('supabase/functions/generate-reply/index.ts')
receive = Path('supabase/functions/receive-widget-message/index.ts')
gate = Path('.github/scripts/task_a3_final_gate.mjs')

for p in [runtime, index, receive, gate]:
    assert p.exists() and p.stat().st_size > 0, f'STOP missing/empty {p}'

s = runtime.read_text()
old = '''import {
  buildCapabilityAwarePreorderNextStep,
  buildGenericCommerceEntityHints,
  genericEntityLabelFromId,
} from "./commerce-capability-runtime.ts";'''
new = old + '''
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import {
  mergeCommerceEntityHints,
  semanticFrameToEntityHints,
  semanticFrameToStateEvents,
} from "./commerce-semantic-adapter.ts";'''
assert old in s, 'STOP runtime import baseline mismatch'
if 'semanticFrameToStateEvents' not in s:
    s = s.replace(old, new, 1)

old = '''  history?: CommerceHistoryTurn[];
  occurred_at?: string | null;
}'''
new = '''  history?: CommerceHistoryTurn[];
  occurred_at?: string | null;
  semantic_frame?: CommerceSemanticFrame | null;
}'''
assert old in s or 'semantic_frame?: CommerceSemanticFrame | null;' in s, 'STOP runtime input baseline mismatch'
if 'semantic_frame?: CommerceSemanticFrame | null;' not in s:
    s = s.replace(old, new, 1)

old = '''  const calculationTurn = detectExplicitCalculationRequest(input.text);
  const hints = calculationTurn ? [] : filterGhostUnscopedHints(input.text, previous, rawHints);
  const derived = calculationTurn ? [] : deriveCommerceEventsFromCustomerTurn({
    text: input.text,
    source_message_id: input.source_message_id,
    occurred_at: input.occurred_at ?? null,
    entity_hints: hints,
    current_language: input.language,
  });
  const runtimeEvents = calculationTurn ? [] : deriveA3RuntimeEvents(input, hints, previous);
  const reduced = reduceCommerceState(previous, [...derived, ...runtimeEvents]);'''
new = '''  const calculationTurn = detectExplicitCalculationRequest(input.text);
  const hints = calculationTurn ? [] : filterGhostUnscopedHints(input.text, previous, rawHints);
  const semanticAuthoritative = !calculationTurn && Boolean(input.semantic_frame && input.semantic_frame.confidence >= 0.72);
  const semanticEvents = semanticAuthoritative
    ? semanticFrameToStateEvents(input.semantic_frame, previous, hints, input.source_message_id, input.occurred_at ?? null)
    : [];
  const derived = calculationTurn || semanticAuthoritative ? [] : deriveCommerceEventsFromCustomerTurn({
    text: input.text,
    source_message_id: input.source_message_id,
    occurred_at: input.occurred_at ?? null,
    entity_hints: hints,
    current_language: input.language,
  });
  const runtimeEvents = calculationTurn ? [] : deriveA3RuntimeEvents(input, hints, previous);
  const reduced = reduceCommerceState(previous, [...semanticEvents, ...derived, ...runtimeEvents]);'''
assert old in s or 'const semanticAuthoritative =' in s, 'STOP reduceTurn baseline mismatch'
if 'const semanticAuthoritative =' not in s:
    s = s.replace(old, new, 1)

old = '''  const historyTexts = (input.history ?? []).filter((turn) => turn.role === "visitor" || turn.role === "user" || turn.role === "customer").slice(0, MAX_HISTORY_TURNS).map((turn) => clean(turn.content));
  const conversationTexts = [text, ...historyTexts];
  const hints = buildCommerceEntityHints(conversationTexts);'''
new = '''  const historyTexts = (input.history ?? []).filter((turn) => turn.role === "visitor" || turn.role === "user" || turn.role === "customer").slice(0, MAX_HISTORY_TURNS).map((turn) => clean(turn.content));
  const conversationTexts = [text, ...historyTexts];
  const deterministicHints = buildCommerceEntityHints(conversationTexts);
  const semanticHints = semanticFrameToEntityHints(input.semantic_frame);
  const hints = mergeCommerceEntityHints(semanticHints, deterministicHints);'''
assert old in s or 'const deterministicHints = buildCommerceEntityHints' in s, 'STOP run runtime hints baseline mismatch'
if 'const deterministicHints = buildCommerceEntityHints' not in s:
    s = s.replace(old, new, 1)
runtime.write_text(s)

s = index.read_text()
old = '''import {
  type CommerceRuntimeOutcome,
  type CommerceStateDbClient,
  runCommerceStateRuntime,
} from "../_shared/commerce-state-runtime.ts";'''
new = old + '''
import { interpretCommerceSemantics } from "../_shared/commerce-semantic-interpreter.ts";
import type { CommerceSemanticFrame } from "../_shared/commerce-semantic-frame.ts";'''
assert old in s, 'STOP generate-reply commerce import baseline mismatch'
if 'interpretCommerceSemantics' not in s:
    s = s.replace(old, new, 1)

marker = '''  // ===== TASK A3: persistent commerce state runtime =====
  // Runs AFTER the critical E2 safety branch and BEFORE CUSTOMER_CONTEXT_UPDATE,
  // generic clarification, conversation-memory shortcut and KB retrieval.
  let _a3Commerce: CommerceRuntimeOutcome | null = null;'''
replacement = '''  // ===== TASK A3.1: multilingual universal semantic interpreter =====
  // LLM proposes a schema-constrained, language-neutral semantic frame only.
  // It never writes commerce state and never supplies external product/policy facts.
  let _a3SemanticFrame: CommerceSemanticFrame | null = null;
  if (_criticalE2ExpectedTenantId) {
    try {
      const semanticResult = await interpretCommerceSemantics({
        company_id: _criticalE2ExpectedTenantId,
        conversation_id,
        source_message_id,
        latest: _h1LastMsg,
        history: (_pr5HistoryRows ?? []).map((row) => ({
          role: String((row as { role?: unknown }).role ?? ""),
          content: String((row as { content?: unknown }).content ?? ""),
        })),
      });
      _a3SemanticFrame = semanticResult.frame;
    } catch (error) {
      console.error("[generate-reply] A3.1 semantic interpreter fallback", error instanceof Error ? error.name : "unknown_error");
    }
  }

  // ===== TASK A3: persistent commerce state runtime =====
  // Runs AFTER the critical E2 safety branch and BEFORE CUSTOMER_CONTEXT_UPDATE,
  // generic clarification, conversation-memory shortcut and KB retrieval.
  let _a3Commerce: CommerceRuntimeOutcome | null = null;'''
assert marker in s or 'TASK A3.1: multilingual universal semantic interpreter' in s, 'STOP generate-reply A3 marker mismatch'
if 'TASK A3.1: multilingual universal semantic interpreter' not in s:
    s = s.replace(marker, replacement, 1)

old = '''          occurred_at: sourceVisitorMessage.created_at ?? null,
          history: (_pr5HistoryRows ?? []).map((row) => ({
            role: String((row as { role?: unknown }).role ?? ""),
            content: String((row as { content?: unknown }).content ?? ""),
          })),
        },'''
new = '''          occurred_at: sourceVisitorMessage.created_at ?? null,
          history: (_pr5HistoryRows ?? []).map((row) => ({
            role: String((row as { role?: unknown }).role ?? ""),
            content: String((row as { content?: unknown }).content ?? ""),
          })),
          semantic_frame: _a3SemanticFrame,
        },'''
assert old in s or 'semantic_frame: _a3SemanticFrame' in s, 'STOP generate-reply runtime call baseline mismatch'
if 'semantic_frame: _a3SemanticFrame' not in s:
    s = s.replace(old, new, 1)
index.write_text(s)

s = receive.read_text()
old = '''    if (!knownShortTopic && (route.kind === "clarify" || route.kind === "underspecified")) {'''
new = '''    // Noise-only input can be clarified locally. Meaningful underspecified input must
    // reach generate-reply so A3.1 multilingual semantic interpretation can resolve
    // ellipsis/referents from conversation context instead of keyword heuristics.
    if (!knownShortTopic && route.kind === "clarify") {'''
assert old in s or 'Meaningful underspecified input must' in s, 'STOP receive-widget semantic pass-through baseline mismatch'
if 'Meaningful underspecified input must' not in s:
    s = s.replace(old, new, 1)
receive.write_text(s)

s = gate.read_text()
old = '''  capability: "supabase/functions/_shared/commerce-capability-runtime.ts",
  contract: "supabase/functions/_shared/commerce-state-contract.ts",'''
new = '''  capability: "supabase/functions/_shared/commerce-capability-runtime.ts",
  semanticFrame: "supabase/functions/_shared/commerce-semantic-frame.ts",
  semanticInterpreter: "supabase/functions/_shared/commerce-semantic-interpreter.ts",
  semanticAdapter: "supabase/functions/_shared/commerce-semantic-adapter.ts",
  contract: "supabase/functions/_shared/commerce-state-contract.ts",'''
assert old in s or 'semanticInterpreter:' in s, 'STOP final gate files baseline mismatch'
if 'semanticInterpreter:' not in s:
    s = s.replace(old, new, 1)

old = '''execFileSync("deno", ["run", "--allow-read", ".github/scripts/task_a3_generic_capability_runtime_test.ts"], { stdio: "inherit" });'''
new = old + '''
execFileSync("deno", ["run", "--allow-read", ".github/scripts/task_a3_task1_universal_semantics_test.ts"], { stdio: "inherit" });
execFileSync("deno", ["check", files.semanticFrame, files.semanticAdapter, files.semanticInterpreter], { stdio: "inherit" });'''
assert old in s or 'task_a3_task1_universal_semantics_test.ts' in s, 'STOP final gate test baseline mismatch'
if 'task_a3_task1_universal_semantics_test.ts' not in s:
    s = s.replace(old, new, 1)

old = '''execFileSync("npx", ["tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", files.runtime, files.capability, files.contract, files.reducer, files.authority], { stdio: "inherit" });'''
new = '''execFileSync("npx", ["tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", files.runtime, files.capability, files.semanticFrame, files.semanticAdapter, files.contract, files.reducer, files.authority], { stdio: "inherit" });'''
assert old in s or 'files.semanticFrame, files.semanticAdapter' in s, 'STOP final gate tsc baseline mismatch'
if 'files.semanticFrame, files.semanticAdapter' not in s:
    s = s.replace(old, new, 1)
gate.write_text(s)

print('A3 TASK1 UNIVERSAL SEMANTICS APPLY PASS')
