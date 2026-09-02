from pathlib import Path

intel = Path('supabase/functions/_shared/conversation-intelligence.ts')
s = intel.read_text()
imp = 'import { classifyCanonicalConversationTurn } from "./conversation-semantic-contract.ts";\n\n'
if not s.startswith(imp):
    s = imp + s

a = s.index('export function classifyConversationTurn(text: string): TurnClassification {')
b = s.index('\nexport function isHumanControlState', a)
fn = '''export function classifyConversationTurn(text: string): TurnClassification {
  const t = text.normalize("NFKC").trim();
  const handoff = classifyHandoffIntent(t);
  const semantic = classifyCanonicalConversationTurn(t, [], { explicit_handoff: handoff.explicit_request });
  switch (semantic.operation) {
    case "TRIVIAL":
      return { kind: "trivial", should_clarify_before_kb: false, reason: semantic.reason };
    case "UNDERSPECIFIED":
      return { kind: "underspecified", should_clarify_before_kb: true, reason: semantic.reason };
    case "CORRECTION":
      return { kind: "correction", should_clarify_before_kb: false, reason: semantic.reason };
    case "FOLLOW_UP_FACTUAL":
    case "PRONOUN_OR_ELLIPSIS":
    case "SIMPLIFY":
    case "REPHRASE":
    case "TRANSLATE":
    case "SUMMARIZE":
    case "RETURN_TO_PRIOR_TOPIC":
    case "CONVERSATION_MEMORY":
      return { kind: "follow_up", should_clarify_before_kb: false, reason: semantic.reason };
    default:
      return { kind: "specific", should_clarify_before_kb: false, reason: semantic.reason };
  }
}
'''
s = s[:a] + fn + s[b:]
intel.write_text(s)

runtime = Path('supabase/functions/_shared/conversation-runtime-state.ts')
r = runtime.read_text()
rimp = 'import { classifyCanonicalConversationTurn, type ConversationOperation, type EvidenceAuthority } from "./conversation-semantic-contract.ts";\n\n'
if not r.startswith(rimp):
    r = rimp + r

old = '  current_intent: string | null;\n  current_topic: string | null;'
new = '  current_intent: string | null;\n  current_operation: ConversationOperation;\n  evidence_authority: EvidenceAuthority;\n  prior_grounded_document_id: string | null;\n  current_topic: string | null;'
if old in r:
    r = r.replace(old, new, 1)

a = r.index('export function detectExplicitJurisdiction(text: string): string | null {')
b = r.index('\nfunction normalizeTopic', a)
jurisdiction = '''export function detectExplicitJurisdiction(text: string): string | null {
  const t = clean(text);
  const candidates: Array<{ id: string; index: number }> = [];
  for (const [id, re] of JURISDICTIONS) {
    const match = t.match(re);
    if (!match || typeof match.index !== "number") continue;
    const before = t.slice(Math.max(0, match.index - 18), match.index);
    const negated = /(不談|不谈|別談|别谈|不要談|不要谈|唔講|唔好講|forget|ignore|drop|not\\s+(?:talk|discuss|about))/i.test(before);
    if (!negated) candidates.push({ id, index: match.index });
  }
  candidates.sort((x, y) => y.index - x.index);
  return candidates[0]?.id ?? null;
}
'''
r = r[:a] + jurisdiction + r[b:]

needle = '  const latest = customers[0]?.text ?? null;\n  const first = chronological[0]?.text ?? null;'
repl = needle + '\n  const semantic = latest ? classifyCanonicalConversationTurn(latest, newestFirst) : null;'
if needle in r and 'const semantic = latest ? classifyCanonicalConversationTurn' not in r:
    r = r.replace(needle, repl, 1)

oldret = '    current_intent: latest,\n    current_topic: currentTopic,'
newret = '    current_intent: latest,\n    current_operation: semantic?.operation ?? "TRIVIAL",\n    evidence_authority: semantic?.evidence_authority ?? "NONE",\n    prior_grounded_document_id: semantic?.prior_grounded_answer?.document_id ?? null,\n    current_topic: currentTopic,'
if oldret in r:
    r = r.replace(oldret, newret, 1)

block = '    `Current customer turn: ${state.latest_customer_turn}`,\n    `Current topic: ${state.current_topic ?? "—"}`,\n    `Jurisdiction: ${state.jurisdiction ?? "unspecified"}`,'
block2 = '    `Current customer turn: ${state.latest_customer_turn}`,\n    `Current operation: ${state.current_operation}`,\n    `Evidence authority: ${state.evidence_authority}`,\n    `Prior grounded document: ${state.prior_grounded_document_id ?? "—"}`,\n    `Current topic: ${state.current_topic ?? "—"}`,\n    `Jurisdiction: ${state.jurisdiction ?? "unspecified"}`,'
if block in r:
    r = r.replace(block, block2, 1)

needle2 = '  const latest = clean(latestInput);\n  const state = projectConversationRuntimeState(newestFirst);\n  if (!latest)'
repl2 = '  const latest = clean(latestInput);\n  const state = projectConversationRuntimeState(newestFirst);\n  const semantic = classifyCanonicalConversationTurn(latest, newestFirst);\n  if (!latest)'
if needle2 in r:
    r = r.replace(needle2, repl2, 1)

r = r.replace('  if (MEMORY.test(latest)) {', '  if (semantic.operation === "CONVERSATION_MEMORY") {', 1)
oldneeds = '''  const needsContext =
    FOLLOW.test(latest) ||
    PRONOUN.test(latest) ||
    (latest.length <= 28 && QUESTION.test(latest)) ||
    isCorrectionText(latest);'''
if oldneeds in r:
    r = r.replace(oldneeds, '  const needsContext = semantic.needs_history;', 1)
oldboundary = '  if (!needsContext || explicitJurisdiction) {'
newboundary = '''  const explicitBoundary = Boolean(explicitJurisdiction) &&
    semantic.operation !== "RETURN_TO_PRIOR_TOPIC" &&
    semantic.operation !== "CORRECTION";
  if (!needsContext || explicitBoundary) {'''
if oldboundary in r:
    r = r.replace(oldboundary, newboundary, 1)

runtime.write_text(r)
