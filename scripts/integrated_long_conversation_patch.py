from pathlib import Path
import re

def must_replace(s: str, old: str, new: str, label: str) -> str:
    if old not in s:
        raise SystemExit(f"MISSING_PATTERN:{label}")
    return s.replace(old, new, 1)

# 1) Multilingual explicit R1 handoff intent.
p = Path("supabase/functions/_shared/conversation-intelligence.ts")
s = p.read_text()
s = must_replace(
    s,
    'const EXPLICIT_ZH = /(?:而家|現在|现在|即刻|立即).{0,8}(轉|转|接|搵|找|聯絡|联系).{0,5}(真人|人工|客服)|(請|请|麻煩|麻烦).{0,8}(轉|转|接|搵|找|聯絡|联系).{0,5}(真人|人工|客服)|(我要|我想|我需要).{0,5}(真人|人工|客服)/;',
    'const EXPLICIT_ZH = /(?:而家|現在|现在|即刻|立即).{0,8}(轉|转|接|搵|找|聯絡|联系).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:請|请|麻煩|麻烦|幫我|帮我).{0,10}(轉|转|接|搵|找|聯絡|联系).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我要|我想|我需要|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)/;',
    "handoff_zh",
)
s = must_replace(
    s,
    r'const EXPLICIT_EN = /\b(please\s+)?(connect|transfer|put|let)\s+me\s+(to|through to)\s+(a\s+)?(human|live agent|human agent|real person)|\b(i want|i need|let me speak to|i want to speak to|i need to speak to)\s+(a\s+)?(human|live agent|human agent|real person)(\s+now)?\b/i;',
    r'const EXPLICIT_EN = /\b(please\s+)?(connect|transfer|put|let)\s+me\s+(to|through to)\s+(a\s+)?(human|live agent|human agent|real person|customer service)|\b(i want|i need|let me speak to|i want to speak to|i need to speak to|connect me to)\s+(a\s+)?(human|live agent|human agent|real person|customer service)(\s+now)?\b/i;',
    "handoff_en",
)
p.write_text(s)

# 2) Conversation memory / continuity.
p = Path("supabase/functions/_shared/conversation-runtime-state.ts")
s = p.read_text()
s = must_replace(
    s,
    'const MEMORY = /(一開始|一开始|第一個問題|第一个问题|最初|剛才建議|刚才建议|之前建議|之前建议|first question|first thing|what did i ask|what did you suggest|earlier recommendation)/i;',
    'const MEMORY = /(一開始|一开始|第一個問題|第一个问题|最初|剛才建議|刚才建议|之前建議|之前建议|剛才談過|刚才谈过|談過的內容|谈过的内容|總結我們|总结我们|first question|first thing|what did i ask|what did you suggest|earlier recommendation|what information have i already given|what have i already given|what is still missing|summari[sz]e.*(?:conversation|discussed|talked))/i;',
    "memory_regex",
)
s = must_replace(
    s,
    'const RECOMMEND = /(建議|建议|需要我提供|請提供|请提供|可以提供|recommend|suggest|provide)/i;',
    'const RECOMMEND = /(建議|建议|需要我提供|請提供|请提供|可以提供|我需要知道|需要知道|仍然需要|還需要|还需要|需要以下資料|需要以下资料|recommend|suggest|provide|i need to know|we still need|still need|information.*missing)/i;',
    "recommend_regex",
)
s = must_replace(
    s,
    r'  const recommendationRequest = /(之前|先前|剛才|刚才|earlier|previous).*(建議|建议|recommend|suggest)|what\s+did\s+you\s+(?:recommend|suggest)/i.test(latest);',
    r'''  const recommendationRequest = /(之前|先前|剛才|刚才|earlier|previous).*(建議|建议|要我提供|需要.*資料|需要.*资料|recommend|suggest)|what\s+did\s+you\s+(?:recommend|suggest)|what\s+information.*(?:missing|need)/i.test(latest);
  const providedMissingRequest = /(我已經提供|我已经提供|我提供過|我提供过|已提供.*哪些|還缺|还缺|仍缺|what\s+information\s+have\s+i\s+already\s+given|what\s+have\s+i\s+already\s+given|what.*still\s+missing)/i.test(latest);
  const generalSummaryRequest = /(最後|最后|請|请)?\s*(?:用.{0,8})?(?:三點|三点|幾點|几点)?\s*(?:總結|总结).*(?:剛才|刚才|我們|我们|談過|谈过|內容|内容)|summari[sz]e.*(?:conversation|discussed|talked|so far)/i.test(latest);''',
    "memory_requests",
)
s = must_replace(
    s,
    '  if (!(firstRequest || correctionRequest || constraintRequest || summaryRequest || recommendationRequest || nameRequest || locationRequest)) return null;',
    '  if (!(firstRequest || correctionRequest || constraintRequest || summaryRequest || recommendationRequest || providedMissingRequest || generalSummaryRequest || nameRequest || locationRequest)) return null;',
    "memory_gate",
)
marker = '  if (summaryRequest) {\n'
inject = '''  if (providedMissingRequest) {
    const priorCustomer = priorRows
      .filter((r) => CUSTOMER.has(String(r.role ?? "").toLowerCase()))
      .map((r) => clean(r.content))
      .filter(Boolean)
      .reverse()
      .slice(-8);
    const supplied = priorCustomer.filter((x) => !QUESTION.test(x) && !MEMORY.test(x)).slice(-5);
    const requested = state.prior_recommendations.slice(0, 4);
    if (lang === "en") {
      const parts: string[] = [];
      if (supplied.length) parts.push(`You have already told me:\n${list(supplied)}`);
      if (requested.length) parts.push(`The information I previously asked for / that may still be missing:\n${list(requested)}`);
      return parts.length ? parts.join("\n\n").slice(0, 1800) : en.none;
    }
    const parts: string[] = [];
    if (supplied.length) parts.push(`你已經提供：\n${list(supplied)}`);
    if (requested.length) parts.push(`我之前要求／仍可能欠缺的資料：\n${list(requested)}`);
    return parts.length ? parts.join("\n\n").slice(0, 1800) : q.none;
  }
  if (generalSummaryRequest) {
    const chronological = priorRows
      .filter((r) => CUSTOMER.has(String(r.role ?? "").toLowerCase()))
      .map((r) => clean(r.content))
      .filter(Boolean)
      .reverse();
    const anchors = [state.first_customer_turn, ...chronological.slice(-6)]
      .filter((x): x is string => Boolean(x))
      .filter((x, i, a) => a.indexOf(x) === i)
      .slice(0, 7);
    if (!anchors.length) return zh ? q.none : en.none;
    const heading = lang === "en" ? "Here is a concise summary of what we discussed:" : "我們剛才主要談到：";
    return `${heading}\n${list(anchors.slice(0, 3))}`.slice(0, 1800);
  }
'''
if marker not in s:
    raise SystemExit("MISSING_PATTERN:memory_inject")
s = s.replace(marker, inject + marker, 1)
s = must_replace(
    s,
    '  const contextTurns = previous.filter((x) => !MEMORY.test(x)).slice(0, 5);',
    '''  const contextTurns = previous.filter((x) => !MEMORY.test(x) && !/^(不要猜|唔好估|不要估|do not guess|don.t guess|不要真人|不需要真人)/i.test(x)).slice(0, 5);
  if (state.first_customer_turn && !contextTurns.includes(state.first_customer_turn) && /(回收|政策|規則|规则|安排|official|policy|recycling)/i.test(latest)) {
    contextTurns.push(state.first_customer_turn);
  }''',
    "context_filter",
)
p.write_text(s)

# 3) Grounding jurisdiction extraction: known jurisdictions only, newest non-negated mention wins.
p = Path("supabase/functions/generate-reply/index.ts")
s = p.read_text()
pattern = re.compile(r'function extractExplicitJurisdictionConstraint\(text: string\): string \| null \{.*?\n\}\n\nfunction evidenceSupportsJurisdiction', re.S)
replacement = r'''function extractExplicitJurisdictionConstraint(text: string): string | null {
  const t = text.normalize("NFKC").trim();
  const jurisdictions: Array<{ label: string; re: RegExp }> = [
    { label: "Mars", re: /(mars|火星)/ig },
    { label: "香港", re: /(香港|hong\s*kong|\bhk\b)/ig },
    { label: "澳門", re: /(澳門|澳门|macau|macao)/ig },
    { label: "新加坡", re: /(新加坡|singapore)/ig },
    { label: "台灣", re: /(台灣|台湾|taiwan)/ig },
    { label: "中國大陸", re: /(中國大陸|中国大陆|內地|内地|mainland\s*china)/ig },
  ];
  const negatedMars = /(不談|不谈|唔講|唔讲|不要談|不要谈|not\s+(?:talking\s+about|about)|forget\s+about)\s*(mars|火星)/i.test(t);
  let best: { label: string; index: number } | null = null;
  for (const item of jurisdictions) {
    item.re.lastIndex = 0;
    for (const match of t.matchAll(item.re)) {
      if (item.label === "Mars" && negatedMars) continue;
      const index = match.index ?? -1;
      if (!best || index > best.index) best = { label: item.label, index };
    }
  }
  return best?.label ?? null;
}

function evidenceSupportsJurisdiction'''
s2, n = pattern.subn(lambda m: replacement, s, count=1)
if n != 1:
    raise SystemExit(f"MISSING_PATTERN:jurisdiction_function:{n}")
p.write_text(s2)

# 4) Realtime anger signal includes normal Chinese wording.
p = Path("supabase/functions/_shared/runtime-signal-lifecycle.ts")
s = p.read_text()
s = must_replace(
    s,
    'const STRONG_ANGER = /(嬲|憤怒|愤怒|火大|離譜|离谱|垃圾|廢物|废物|荒謬|荒谬|angry|furious|irate|rage|ridiculous|unacceptable|bullshit)/i;',
    'const STRONG_ANGER = /(嬲|生氣|生气|好嬲|很氣|很气|憤怒|愤怒|火大|離譜|离谱|垃圾|廢物|废物|荒謬|荒谬|angry|furious|irate|rage|ridiculous|unacceptable|bullshit)/i;',
    "anger",
)
p.write_text(s)

# 5) CE evaluator: bounded second attempt on invalid output + deterministic emotion fallback.
p = Path("supabase/functions/_shared/ce-automation-engine.ts")
s = p.read_text()
pattern = re.compile(r'async function runEvaluator\(.*?\n\}\n\nasync function runSignals\(', re.S)
new_func = '''async function runEvaluator(
  dimension: CeDimension,
  bundle: string,
  knownChunkIds: ReadonlySet<string>,
  operationId: string,
  companyId: string | null,
  conversationId: string,
  local: boolean,
) {
  let lastCode = "CE_PROVIDER_INVALID_OUTPUT";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await callModel({
      purpose: "evaluation",
      system: local ? LOCAL_EVALUATOR_SYSTEM_PROMPT[dimension] : EVALUATOR_SYSTEM_PROMPT[dimension],
      user: bundle,
      maxTokens: EVALUATOR_MAX_TOKENS,
      operationId: `${operationId}:${dimension}:attempt${attempt}`,
      companyId,
      conversationId,
      tag: `ce:auto:${dimension}`,
      responseFormat: "json",
      responseSchema: EVALUATOR_RESPONSE_SCHEMA,
    });
    if (!res.ok) {
      lastCode = toCeErrorCode(res.code);
      if (attempt < 2 && (res.code === "LLM_NETWORK" || res.code === "LLM_TIMEOUT" || res.code === "LLM_NON_2XX")) continue;
      return { ok: false as const, code: lastCode };
    }
    const parsed = parseJsonObject(res.text);
    const out = validateEvaluatorOutput(parsed, knownChunkIds);
    if (out) return { ok: true as const, ...out, model: res.model, raw: parsed! };
    lastCode = "CE_PROVIDER_INVALID_OUTPUT";
  }
  return { ok: false as const, code: lastCode };
}

function deterministicEmotionPoints(transcript: TranscriptEntry[]) {
  const strong = /(嬲|生氣|生气|很氣|很气|憤怒|愤怒|火大|angry|furious|irate|rage|unacceptable)/i;
  const negative = /(失望|不滿|不满|很差|太差|煩|烦|frustrated|annoyed|upset|disappointed|terrible|awful)/i;
  const positive = /(謝謝|谢谢|明白了|明白啦|thanks|thank you|got it|that helps)/i;
  const out: Array<{ message_id: string; turn_index: number; occurred_at: string; sentiment: "very_negative" | "negative" | "positive"; sentiment_score: number; trigger_label: string }> = [];
  let customerTurn = 0;
  for (const e of transcript) {
    if (!e.included || e.role !== "customer") continue;
    customerTurn++;
    if (strong.test(e.content)) out.push({ message_id: e.id, turn_index: customerTurn, occurred_at: e.created_at, sentiment: "very_negative", sentiment_score: -0.9, trigger_label: "deterministic_strong_anger" });
    else if (negative.test(e.content)) out.push({ message_id: e.id, turn_index: customerTurn, occurred_at: e.created_at, sentiment: "negative", sentiment_score: -0.55, trigger_label: "deterministic_negative" });
    else if (positive.test(e.content)) out.push({ message_id: e.id, turn_index: customerTurn, occurred_at: e.created_at, sentiment: "positive", sentiment_score: 0.4, trigger_label: "deterministic_positive" });
  }
  return out;
}

async function runSignals('''
s2, n = pattern.subn(lambda m: new_func, s, count=1)
if n != 1:
    raise SystemExit(f"MISSING_PATTERN:runEvaluator:{n}")
s = s2
s = must_replace(
    s,
    '''    const signals = await runSignals(
      bundle.text, bundle.transcript, operationId, companyId, job.conversation_id,
    );''',
    '''    const modelSignals = await runSignals(
      bundle.text, bundle.transcript, operationId, companyId, job.conversation_id,
    );
    const deterministicEmotion = deterministicEmotionPoints(bundle.transcript);
    const modelEmotion = modelSignals?.emotion ?? [];
    const seenEmotionMessageIds = new Set(modelEmotion.map((x) => x.message_id));
    const signals = {
      emotion: [...modelEmotion, ...deterministicEmotion.filter((x) => !seenEmotionMessageIds.has(x.message_id))].slice(0, 40),
      next_steps: modelSignals?.next_steps ?? [],
    };''',
    "signals_merge",
)
p.write_text(s)

# 6) Regression tests.
Path("tests/edge/integrated-long-conversation-closure.test.ts").write_text('''import { assert, assertEquals } from "jsr:@std/assert@1";
import { classifyHandoffIntent } from "../../supabase/functions/_shared/conversation-intelligence.ts";
import { detectExplicitJurisdiction, resolveConversationMemoryResponse } from "../../supabase/functions/_shared/conversation-runtime-state.ts";
import { classifyCurrentTurnEmotion } from "../../supabase/functions/_shared/runtime-signal-lifecycle.ts";

Deno.test("multilingual explicit R1 phrases and negation", () => {
  for (const text of ["我要真人客服。", "幫我轉真人客服。", "帮我转真人客服。", "我要搵真人。", "Connect me to a human agent.", "I want customer service."]) {
    assertEquals(classifyHandoffIntent(text).explicit_request, true, text);
  }
  assertEquals(classifyHandoffIntent("我現在先想弄清楚問題，不要立即轉真人。").explicit_request, false);
});

Deno.test("generic words are not jurisdictions", () => {
  assertEquals(detectExplicitJurisdiction("那官方的回收安排是什麼？"), null);
  assertEquals(detectExplicitJurisdiction("Please summarize the policy."), null);
});

Deno.test("conversation memory recalls supplied and missing information across language", () => {
  const rows = [
    { role: "visitor", content: "What information have I already given you, and what is still missing?" },
    { role: "assistant", content: "請提供冷氣機型號及訂單號碼。" },
    { role: "visitor", content: "品牌是 Panasonic，大約兩年前買，現在會開機但不冷。" },
    { role: "visitor", content: "我沒有型號，也沒有訂單號。" },
  ];
  const reply = resolveConversationMemoryResponse(rows[0].content, rows);
  assert(reply && reply.includes("Panasonic"));
  assert(reply && (reply.includes("型號") || reply.includes("model")));
});

Deno.test("general summary is routed to conversation memory", () => {
  const rows = [
    { role: "visitor", content: "最後用三點總結我們剛才談過的內容。" },
    { role: "assistant", content: "好的。" },
    { role: "visitor", content: "我沒有型號。" },
    { role: "visitor", content: "什么是四電一腦？" },
  ];
  const reply = resolveConversationMemoryResponse(rows[0].content, rows);
  assert(reply && reply.includes("四電一腦"));
});

Deno.test("Chinese anger becomes realtime signal", () => {
  const x = classifyCurrentTurnEmotion("我是 VIP 客戶，真的很生氣，但先不要轉真人。");
  assertEquals(x.anger_flag, true);
  assert(typeof x.sentiment_score === "number" && x.sentiment_score < -0.5);
});
''')

print("INTEGRATED_PATCH_APPLIED=PASS")
