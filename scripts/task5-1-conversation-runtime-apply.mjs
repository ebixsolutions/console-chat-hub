import fs from 'node:fs';

const ciPath = 'supabase/functions/_shared/conversation-intelligence.ts';
const genPath = 'supabase/functions/generate-reply/index.ts';

function mustCount(source, needle, expected, label) {
  const count = source.split(needle).length - 1;
  if (count !== expected) throw new Error(`${label}: expected ${expected}, found ${count}`);
}

let ci = fs.readFileSync(ciPath, 'utf8');
const marker = 'export interface CustomerAdvisorySignals {';
if (!ci.includes('export function buildContextualRetrievalQuery(')) {
  mustCount(ci, marker, 1, 'conversation-intelligence insertion marker');
  const addition = String.raw`
export interface ContextualRetrievalQuery {
  query: string;
  mode: "standalone" | "contextual";
  latest: string;
  context_turns: string[];
}

const CONTEXTUAL_FOLLOW_UP = /^(?:咁|那|那麼|那么|所以|另外|仲有|还有|咁如果|那如果|如果|再|又|而|同埋|還有|还有|what about|and what about|then|so|also|in that case|how about)\b?/i;
const CONTEXTUAL_PRONOUN = /(?:^|[\s，,。.!！?？])(那個|那个|這個|这个|它|佢|他|她|嗰個|呢個|上述|剛才|刚才|之前|前面|that|this|it|they|them|those|these|the one|earlier|above)(?:$|[\s，,。.!！?？])/i;
const CONTEXTUAL_STYLE_REQUEST = /^(?:簡單一點|简单一点|簡單啲|简单点|再簡單|再简单|詳細一點|详细一点|再詳細|再详细|說清楚一點|说清楚一点|用繁體中文|用繁体中文|用簡體中文|用简体中文|用英文|in english|explain(?: it| that)? (?:more )?simply|make it simpler|more detail|simpler|shorter)(?:[。.!！?？\s].*)?$/i;
const CONTEXTUAL_ELLIPSIS = /(?:呢|呢？|嗎|吗|呢\?|呢？|呢。|呢！|about that|and that|same one|same thing)$/i;

function isRetrievalNoise(text: string): boolean {
  const t = text.trim();
  if (!t || TRIVIAL.test(t)) return true;
  const handoff = classifyHandoffIntent(t);
  return handoff.kind !== "none" && !handoff.pure_negation;
}

/**
 * Builds a bounded retrieval query before RAG. It never invents entities or facts:
 * contextual mode only combines the current customer request with prior customer
 * statements from the same trusted conversation history. Newest corrections remain
 * visible and old assistant/system text is never used as factual context.
 */
export function buildContextualRetrievalQuery(
  latestMessage: string,
  newestFirstMessages: ConversationHistoryRow[],
): ContextualRetrievalQuery {
  const latest = cleanContinuityText(latestMessage);
  if (!latest) return { query: "", mode: "standalone", latest: "", context_turns: [] };

  const turns = newestFirstMessages
    .filter((row) => CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase()))
    .map((row) => cleanContinuityText(row.content))
    .filter(Boolean)
    .slice(0, 20);

  // History is newest-first in generate-reply. Remove one copy of the current turn.
  let skippedCurrent = false;
  const previousTurns = turns.filter((text) => {
    if (!skippedCurrent && text === latest) {
      skippedCurrent = true;
      return false;
    }
    return true;
  });

  if (previousTurns.length === 0) {
    return { query: latest, mode: "standalone", latest, context_turns: [] };
  }

  const turnClass = classifyConversationTurn(latest);
  const shortContinuation = latest.length <= 28 && (
    CONTEXTUAL_FOLLOW_UP.test(latest) ||
    CONTEXTUAL_PRONOUN.test(latest) ||
    CONTEXTUAL_STYLE_REQUEST.test(latest) ||
    CONTEXTUAL_ELLIPSIS.test(latest)
  );
  const needsContext = turnClass.kind === "follow_up" ||
    turnClass.kind === "correction" ||
    shortContinuation;

  if (!needsContext) {
    return { query: latest, mode: "standalone", latest, context_turns: [] };
  }

  const contextTurns = previousTurns
    .filter((text) => !isRetrievalNoise(text))
    .slice(0, 3);
  if (contextTurns.length === 0) {
    return { query: latest, mode: "standalone", latest, context_turns: [] };
  }

  const query = [
    `Current request: ${latest}`,
    `Relevant prior customer context: ${contextTurns.join(" / ")}`,
  ].join("\n").slice(0, 1200);

  return { query, mode: "contextual", latest, context_turns: contextTurns };
}

`;
  ci = ci.replace(marker, addition + marker);
  fs.writeFileSync(ciPath, ci);
}

let gen = fs.readFileSync(genPath, 'utf8');
const oldImport = 'import { CUSTOMER_CONVERSATION_POLICY, NATURAL_CLARIFICATION, buildConversationContinuityBlock, buildCustomerAdvisoryContext, classifyConversationTurn, classifyHandoffIntent, hasUsableFullContentEvidence, isHumanControlState } from "../_shared/conversation-intelligence.ts";';
const newImport = 'import { CUSTOMER_CONVERSATION_POLICY, NATURAL_CLARIFICATION, buildContextualRetrievalQuery, buildConversationContinuityBlock, buildCustomerAdvisoryContext, classifyConversationTurn, classifyHandoffIntent, hasUsableFullContentEvidence, isHumanControlState } from "../_shared/conversation-intelligence.ts";';
if (!gen.includes('buildContextualRetrievalQuery, buildConversationContinuityBlock')) {
  mustCount(gen, oldImport, 1, 'generate-reply import');
  gen = gen.replace(oldImport, newImport);
}

const oldQuery = '    const userQuery = _h1LastMsg;\n    ragResult = !userQuery ? { success: true, no_answer: true, retrieval_quality: "failed", chunks: [] } : await callKBAdapter(conversation_id, userQuery, _kbTenantResult.scope);';
const newQuery = '    const _semanticRetrieval = buildContextualRetrievalQuery(_h1LastMsg, _pr5HistoryRows ?? []);\n    const userQuery = _semanticRetrieval.query;\n    ragResult = !userQuery ? { success: true, no_answer: true, retrieval_quality: "failed", chunks: [] } : await callKBAdapter(conversation_id, userQuery, _kbTenantResult.scope);';
if (!gen.includes('const _semanticRetrieval = buildContextualRetrievalQuery(')) {
  mustCount(gen, oldQuery, 1, 'generate-reply retrieval call');
  gen = gen.replace(oldQuery, newQuery);
}
fs.writeFileSync(genPath, gen);

console.log('TASK5_1_CONVERSATION_RUNTIME_APPLY=PASS');
