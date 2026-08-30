import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildConversationContinuityBlock,
  classifyConversationTurn,
  classifyHandoffIntent,
} from "../supabase/functions/_shared/conversation-intelligence.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  assert.deepEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`PASS ${label}`);
}

// Multi-turn classification / correction / follow-up continuity.
eq(classifyConversationTurn("What is your return policy?").kind, "specific", "specific turn");
eq(classifyConversationTurn("Then what about opened items?").kind, "follow_up", "English follow-up");
eq(classifyConversationTurn("咁如果已經開咗盒呢？").kind, "follow_up", "Traditional Chinese follow-up");
eq(classifyConversationTurn("Actually, I meant an online order.").kind, "correction", "correction turn");
const continuity = buildConversationContinuityBlock([
  { role: "visitor", content: "Actually, I meant an online order." },
  { role: "assistant", content: "Do you mean an in-store purchase?" },
  { role: "visitor", content: "I want to return an item." },
]);
assert.match(continuity, /newest customer statement as authoritative/i);
assert.match(continuity, /Actually, I meant an online order\./);
console.log("PASS continuity block newest-correction precedence");

// Handoff false-positive matrix plus explicit request.
eq(classifyHandoffIntent("I want a human agent now").explicit_request, true, "explicit human request");
eq(classifyHandoffIntent("I don't want a human agent").explicit_request, false, "negated human request");
eq(classifyHandoffIntent("You mentioned a human agent earlier").explicit_request, false, "human reference");
eq(classifyHandoffIntent("When is customer service available?").explicit_request, false, "human-support question");
eq(classifyHandoffIntent("If you cannot answer, then connect me to a human").explicit_request, false, "conditional human request");
eq(classifyHandoffIntent("Maybe connect me to a human later").explicit_request, false, "future human request");

const source = readFileSync("supabase/functions/generate-reply/index.ts", "utf8");
assert.match(source, /ENABLE_KB_ADAPTER"\) !== "false"/);
assert.match(source, /ESC_ENABLE_REQUIRED_RULES_LIVE"\) === "false"/);
assert.match(source, /enabled\.add\("R2"\)/);
assert.match(source, /attemptFirstNoMatchClarification/);
assert.match(source, /KB_EMPTY/);
assert.match(source, /KB_LOW_SCORE_STANDARD/);
assert.match(source, /isSameIntentRepeat/);
assert.match(source, /buildConversationContinuityBlock/);
console.log("PASS KB default-on / first-no-match / R2 source contracts");

const llm = readFileSync("supabase/functions/_shared/llm-router.ts", "utf8");
assert.match(llm, /GENERATION_MAX_TOKENS_DEFAULT = 2048/);
assert.match(llm, /GENERATION_MAX_TOKENS_MIN = 768/);
assert.match(llm, /GENERATION_MAX_TOKENS_MAX = 8192/);
assert.match(llm, /MAX_TOKENS/);
assert.match(llm, /LLM_INVALID_OUTPUT/);
console.log("PASS generation budget and truncation fail-closed contract");

const kb = readFileSync("supabase/functions/_shared/kb-client.ts", "utf8");
assert.match(kb, /py\.ebixmall\.com\/py-knowledge-base/);
assert.match(kb, /KB_SINGAPORE_TENANT_MAP_JSON/);
assert.match(kb, /max_documents/);
assert.match(kb, /full_content/);
console.log("PASS Singapore KB tenant/full-content source contract");

console.log("TASK4_1_CREDENTIAL_INDEPENDENT_REGRESSION=PASS");
