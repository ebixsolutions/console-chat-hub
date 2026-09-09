import fs from "node:fs";

const target = "supabase/functions/generate-reply/index.ts";
let source = fs.readFileSync(target, "utf8");

const importMarker = `import {\n  buildCanonicalContinuityBlock,\n  buildCanonicalRetrievalQuery,\n  buildWorkflow5TopicalClarification,\n  workflow5ShortTopicHint,\n  resolveConversationMemoryResponse,\n  resolveWorkflow5ConversationLanguage,\n} from "../_shared/conversation-runtime-state.ts";`;
const importLine = `import { resolveCommerceRuntimeTurn } from "../_shared/commerce-state-runtime.ts";`;

if (!source.includes(importLine)) {
  if (!source.includes(importMarker)) throw new Error("A3 import anchor not found");
  source = source.replace(importMarker, `${importMarker}\n${importLine}`);
}

const anchor = `  const _canonicalTurn = classifyCanonicalConversationTurn(\n    _h1LastMsg,\n    _pr5HistoryRows ?? [],\n    { explicit_handoff: isHandoffIntent(_h1LastMsg) },\n  );`;
const block = `  // Task A3: canonical persistent commerce state + authority routing.\n  // Runs after critical E2 safety handling and before customer-context / generic clarification / KB retrieval.\n  // This preserves the existing safety gate while preventing known customer facts from being re-asked.\n  const _commerceRuntime = await resolveCommerceRuntimeTurn({\n    supabaseAdmin,\n    conversation_id,\n    company_id: conversation.company_id ?? null,\n    source_message_id,\n    customer_text: _h1LastMsg,\n    occurred_at: (sourceVisitorMessage as { created_at?: string | null }).created_at ?? null,\n    language: _visitorLang as "zh-TW" | "zh-CN" | "en",\n  });\n  if (_commerceRuntime.handled && _commerceRuntime.reply) {\n    const commerceCommit = await commitAiReplyWithControlGate(\n      supabaseAdmin,\n      conversation_id,\n      source_message_id,\n      _commerceRuntime.reply,\n      {\n        ..._commerceRuntime.metadata,\n        escalation_action: "continue_ai",\n        handoff_required: false,\n      },\n    );\n    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);\n    if (commerceCommit.ok) {\n      return new Response(\n        JSON.stringify({\n          success: true,\n          reply: _commerceRuntime.reply,\n          response_route: _commerceRuntime.metadata.response_route ?? "commerce_runtime",\n          answer_authority: _commerceRuntime.authority ?? null,\n          handoff_required: false,\n        }),\n        { headers: { ...corsHeaders, "Content-Type": "application/json" } },\n      );\n    }\n    if (["human_control", "resolved", "superseded_source"].includes(commerceCommit.result)) {\n      return new Response(\n        JSON.stringify({ success: true, skipped: commerceCommit.result }),\n        { headers: { ...corsHeaders, "Content-Type": "application/json" } },\n      );\n    }\n    return new Response(\n      JSON.stringify({ success: false, error: \`commerce_runtime_commit_\${commerceCommit.result}\` }),\n      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },\n    );\n  }\n\n${anchor}`;

if (!source.includes("Task A3: canonical persistent commerce state + authority routing.")) {
  const occurrences = source.split(anchor).length - 1;
  if (occurrences !== 1) throw new Error(`A3 orchestration anchor count=${occurrences}`);
  source = source.replace(anchor, block);
}

for (const token of [
  importLine,
  "resolveCommerceRuntimeTurn({",
  "response_route: _commerceRuntime.metadata.response_route",
  "answer_authority: _commerceRuntime.authority",
  "Task A3: canonical persistent commerce state + authority routing.",
]) {
  if (!source.includes(token)) throw new Error(`A3 patch missing token: ${token}`);
}

fs.writeFileSync(target, source);
console.log(JSON.stringify({ status: "PASS", task: "A3_PATCH", target }));
