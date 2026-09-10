#!/usr/bin/env python3
from pathlib import Path

cap = Path('supabase/functions/_shared/commerce-capability-runtime.ts')
runtime = Path('supabase/functions/_shared/commerce-state-runtime.ts')
conv = Path('supabase/functions/_shared/conversation-runtime-state.ts')
gate = Path('.github/scripts/task_a3_final_gate.mjs')
test = Path('.github/scripts/task_a3_hotfix8_cross_industry_closure_test.ts')

for p in (cap, runtime, conv, gate):
    assert p.exists() and p.stat().st_size > 0, f'STOP missing/empty {p}'

s = cap.read_text()
old = '''    .replace(/(?:星期[一二三四五六日天]|週[一二三四五六日天]|周[一二三四五六日天]|monday|tuesday|wednesday|thursday|friday|saturday|sunday).*$/i, "")'''
new = '''    .replace(/(?:星期[一二三四五六日天]|週[一二三四五六日天]|周[一二三四五六日天]|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\s*/gi, "")'''
assert old in s, 'STOP capability weekday baseline mismatch'
s = s.replace(old, new, 1)
old = '''    .replace(/^(?:size\\s*[xsml0-9-]+)\\s+/i, "")
    .trim();'''
new = '''    .replace(/^(?:size\\s*[xsml0-9-]+)\\s+/i, "")
    .replace(/^(?:[XSML]{1,4})\\s*碼\\s*/i, "")
    .trim();'''
assert old in s, 'STOP capability leading size baseline mismatch'
s = s.replace(old, new, 1)
cap.write_text(s)

s = runtime.read_text()
anchor = '''function hintsMentionedInTurn(text: string, hints: CommerceTurnEntityHint[]): CommerceTurnEntityHint[] {
  const lower = clean(text).toLowerCase();
  const rooms = detectRooms(text);
  const categories = detectCategories(text).map((x) => x.key);
  return hints.filter((hint) => {
    if (hint.entity_id.startsWith("generic:")) {
      return (hint.aliases ?? []).some((alias) => {
        const normalized = clean(alias, 80).toLowerCase();
        return normalized.length >= 2 && lower.includes(normalized);
      });
    }
    if (!categories.includes(hint.category)) return false;
    const [, roomKey] = hint.entity_id.split(":");
    if (!rooms.length) return true;
    if (roomKey === "unscoped") return false;
    return rooms.some((room) => room.key === roomKey) || Boolean(lower) === false;
  });
}
'''
assert anchor in s, 'STOP runtime hint baseline mismatch'
addition = anchor + '''
function bindSingleGenericContextHint(
  text: string,
  state: ConversationCommerceState,
  hints: CommerceTurnEntityHint[],
): CommerceTurnEntityHint[] {
  const t = clean(text);
  if (!t) return hints;
  const lower = t.toLowerCase();
  const explicitGenericMention = hints.some((hint) =>
    hint.entity_id.startsWith("generic:") &&
    (hint.aliases ?? []).some((alias) => {
      const normalized = clean(alias, 80).toLowerCase();
      return normalized.length >= 2 && lower.includes(normalized);
    })
  );
  if (explicitGenericMention) return hints;

  const active = state.entities.filter((entity) =>
    entity.entity_id.startsWith("generic:") &&
    entity.status !== "cancelled" &&
    entity.status !== "deferred"
  );
  if (active.length !== 1) return hints;

  const quantityQuestion = /(?:總共有幾多|总共有多少|合共幾多|合共多少|一共幾多|一共多少|how many.*(?:total|altogether))/i.test(t);
  const contextual = detectAdditiveEntityCreationSignal(t) || detectQuantityCorrectionSignal(t) || quantityQuestion;
  if (!contextual) return hints;

  const entity = active[0];
  const existing = hints.find((hint) => hint.entity_id === entity.entity_id);
  const bound: CommerceTurnEntityHint = existing
    ? { ...existing, aliases: [...new Set([...(existing.aliases ?? []), t])] }
    : {
        entity_id: entity.entity_id,
        category: entity.category,
        aliases: [t],
        quantity: entity.quantity,
        brand: entity.brand,
        model: entity.model,
        attributes: entity.attributes,
        constraints: entity.constraints,
      };
  return [...hints.filter((hint) => hint.entity_id !== entity.entity_id), bound];
}
'''
s = s.replace(anchor, addition, 1)
old = '''  const calculationTurn = detectExplicitCalculationRequest(input.text);
  const hints = calculationTurn ? [] : filterGhostUnscopedHints(input.text, previous, rawHints);'''
new = '''  const calculationTurn = detectExplicitCalculationRequest(input.text);
  const contextBoundHints = calculationTurn ? rawHints : bindSingleGenericContextHint(input.text, previous, rawHints);
  const hints = calculationTurn ? [] : filterGhostUnscopedHints(input.text, previous, contextBoundHints);'''
assert old in s, 'STOP runtime reduceTurn baseline mismatch'
s = s.replace(old, new, 1)
runtime.write_text(s)

s = conv.read_text()
old = '''export function workflow5ShortTopicHint(text: string): string | null {
  const normalized = (text || "").trim().toLowerCase();
  if (!normalized) return null;
  let compact = normalized.replace(/\\s+/g, "");'''
new = '''export function workflow5ShortTopicHint(text: string): string | null {
  const normalized = (text || "").trim().toLowerCase();
  if (!normalized) return null;
  if (/(?:想預訂|想预订|想訂|想订|要預訂|要预订|預訂|预订|想預約|想预约|要預約|要预约|預約|预约|reserve|reservation|book(?:ing)?|pre[- ]?order|want to order|place an order).{0,32}(?:未付款|未支付|未付|not paid|haven't paid|have not paid)|(?:未付款|未支付|未付|not paid|haven't paid|have not paid).{0,32}(?:預訂|预订|預約|预约|reserve|reservation|book|pre[- ]?order|order)/i.test(normalized)) return "commerce preorder unpaid";
  let compact = normalized.replace(/\\s+/g, "");'''
assert old in s, 'STOP workflow5ShortTopicHint baseline mismatch'
s = s.replace(old, new, 1)
conv.write_text(s)

test.write_text(r'''import {
  buildCommerceEntityHints,
  reduceTurn,
} from "../../supabase/functions/_shared/commerce-state-runtime.ts";
import {
  extractGenericCommerceEntity,
} from "../../supabase/functions/_shared/commerce-capability-runtime.ts";
import { createEmptyConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import { workflow5ShortTopicHint } from "../../supabase/functions/_shared/conversation-runtime-state.ts";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

const company = "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493";
const conversation = "88888888-8888-4888-8888-888888888888";
let seq = 0;
function turn(state: ReturnType<typeof createEmptyConversationCommerceState>, text: string, history: string[] = []) {
  seq += 1;
  const hints = buildCommerceEntityHints([text, ...history]);
  return reduceTurn(state, {
    conversation_id: conversation,
    company_id: company,
    source_message_id: `88888888-8888-4888-8888-${String(seq).padStart(12, "0")}`,
    text,
    language: "zh-TW",
  }, hints);
}

const exactFashion = extractGenericCommerceEntity("我要2件黑色M碼T-shirt。");
assert(exactFashion?.entity_id === "generic:t-shirt", `exact fashion id mismatch: ${exactFashion?.entity_id}`);
assert(exactFashion?.variant.size === "M" && exactFashion.variant.color === "黑色", "exact fashion variants failed");

const exactService = extractGenericCommerceEntity("我要預約2位星期五剪髮。");
assert(exactService?.entity_id === "generic:剪髮", `exact service id mismatch: ${exactService?.entity_id}`);
assert(exactService?.kind === "service" && exactService.capabilities.requires_booking === true, "exact service booking extraction failed");

let grocery = turn(createEmptyConversationCommerceState(), "我要3盒牛奶。");
assert(grocery.entities.length === 1 && grocery.entities[0].quantity === 3, "grocery initial state failed");
grocery = turn(grocery, "另外加2盒。", ["我要3盒牛奶。");
'''.replace('["我要3盒牛奶。");','["我要3盒牛奶。"]);') + r'''
assert(grocery.entities.length === 1 && grocery.entities[0].quantity === 5, `ellipsis additive failed: ${grocery.entities[0]?.quantity}`);
grocery = turn(grocery, "總共有幾多盒？", ["另外加2盒。", "我要3盒牛奶。");
'''.replace('["另外加2盒。", "我要3盒牛奶。");','["另外加2盒。", "我要3盒牛奶。"]);') + r'''
assert(grocery.entities[0].quantity === 5, "quantity question mutated generic state");

let correction = turn(createEmptyConversationCommerceState(), "我要2件T-shirt。");
'''.replace('["我要2件T-shirt。");','["我要2件T-shirt。"]);') + r'''
correction = turn(correction, "更正，唔係2件，係3件。", ["我要2件T-shirt。");
'''.replace('["我要2件T-shirt。");','["我要2件T-shirt。"]);') + r'''
assert(correction.entities[0].quantity === 3, "ellipsis correction regressed");

assert(workflow5ShortTopicHint("我想預訂，但未付款。") === "commerce preorder unpaid", "preorder unpaid still intercepted as underspecified");
assert(workflow5ShortTopicHint("我想預約，但未付款。") === "commerce preorder unpaid", "service preorder unpaid routing failed");

console.log(JSON.stringify({
  status: "PASS",
  gate: "TASK_A3_HOTFIX8_CROSS_INDUSTRY_CLOSURE",
  cases: 7,
  assertions: {
    exact_fashion_variant_canonicalization: true,
    exact_service_booking_extraction: true,
    generic_ellipsis_additive_3_plus_2_equals_5: true,
    generic_quantity_question_read_only: true,
    generic_ellipsis_correction: true,
    preorder_unpaid_bypasses_underspecified: true,
    service_preorder_unpaid_bypasses_underspecified: true
  }
}));
''')

s = gate.read_text()
old = '''execFileSync("deno", ["run", "--allow-read", ".github/scripts/task_a3_generic_capability_runtime_test.ts"], { stdio: "inherit" });'''
new = old + '''\nexecFileSync("deno", ["run", "--allow-read", ".github/scripts/task_a3_hotfix8_cross_industry_closure_test.ts"], { stdio: "inherit" });'''
assert old in s, 'STOP final gate generic test baseline mismatch'
assert 'task_a3_hotfix8_cross_industry_closure_test.ts' not in s, 'STOP hotfix8 already applied'
s = s.replace(old, new, 1)
gate.write_text(s)

print('A3 HOTFIX8 CROSS-INDUSTRY APPLY PASS')
