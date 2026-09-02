from pathlib import Path

# ---- llm-router: support prior-grounded transform evidence as verifier authority ----
router = Path('supabase/functions/_shared/llm-router.ts')
s = router.read_text()

old = '''interface ParsedGroundingBlock {
  evidence_text: string;
  chunk_ids: string[];
}'''
new = '''interface ParsedGroundingBlock {
  authority: "CURRENT_KB" | "PRIOR_GROUNDED_ANSWER";
  evidence_text: string;
  chunk_ids: string[];
}'''
if old in s:
    s = s.replace(old, new, 1)

old = '''export function extractGroundingBlock(system: string): ParsedGroundingBlock | null {
  if (!system.includes("Knowledge Base grounding rules:")) return null;
  const marker = "Full Content Evidence:\\n";
  const markerIndex = system.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const raw = system.slice(markerIndex + marker.length).trim();
  if (!raw || /^none\\b/i.test(raw)) return null;
  const ids = [...raw.matchAll(/\\[chunk:([^\\]\\s]+)\\]/g)]
    .map((match) => (match[1] ?? "").trim())
    .filter(Boolean);
  return {
    evidence_text: raw.slice(0, 6000),
    chunk_ids: [...new Set(ids)],
  };
}'''
new = '''export function extractGroundingBlock(system: string): ParsedGroundingBlock | null {
  const transformRules = "Prior Grounded Answer transform rules:";
  const transformMarker = "Prior Grounded Answer Evidence:\\n";
  if (system.includes(transformRules)) {
    const transformIndex = system.lastIndexOf(transformMarker);
    if (transformIndex >= 0) {
      const prior = system.slice(transformIndex + transformMarker.length).trim();
      if (prior) {
        return {
          authority: "PRIOR_GROUNDED_ANSWER",
          evidence_text: prior.slice(0, 3000),
          chunk_ids: [],
        };
      }
    }
    return null;
  }

  if (!system.includes("Knowledge Base grounding rules:")) return null;
  const marker = "Full Content Evidence:\\n";
  const markerIndex = system.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const raw = system.slice(markerIndex + marker.length).trim();
  if (!raw || /^none\\b/i.test(raw)) return null;
  const ids = [...raw.matchAll(/\\[chunk:([^\\]\\s]+)\\]/g)]
    .map((match) => (match[1] ?? "").trim())
    .filter(Boolean);
  return {
    authority: "CURRENT_KB",
    evidence_text: raw.slice(0, 6000),
    chunk_ids: [...new Set(ids)],
  };
}'''
if old in s:
    s = s.replace(old, new, 1)

old = '''  const verifierSystem = [
    "You are a strict factual-grounding verifier.",
    "Judge ONLY whether every factual claim in the proposed answer is entailed by the supplied evidence.",
    "Do not use outside knowledge, assumptions, the customer request, or prior conversation as factual evidence.",
    "Politeness, conversational transitions, and non-factual wording do not need evidence.",'''
new = '''  const verifierSystem = [
    "You are a strict factual-grounding verifier.",
    grounding.authority === "PRIOR_GROUNDED_ANSWER"
      ? "The evidence is a previously verified grounded answer. Judge whether the proposed answer is a faithful simplification, rephrase, translation, or summary of that evidence without any new factual claim. Wording and language may differ, and a summary may omit detail."
      : "Judge ONLY whether every factual claim in the proposed answer is entailed by the supplied current Knowledge Base evidence.",
    "Do not use outside knowledge, assumptions, the customer request, or other prior conversation as factual evidence.",
    "Politeness, conversational transitions, and non-factual wording do not need evidence.",'''
if old in s:
    s = s.replace(old, new, 1)

old = '''      event: "grounding_semantic_rejected",
          request_id: call.operationId,
          unsupported_claim_count: decision.unsupported_claims.length,'''
new = '''      event: "grounding_semantic_rejected",
          request_id: call.operationId,
          grounding_authority: grounding.authority,
          unsupported_claim_count: decision.unsupported_claims.length,'''
if old in s:
    s = s.replace(old, new, 1)

router.write_text(s)

# ---- generate-reply: bind transform to prior grounded evidence + inherited lineage ----
gen = Path('supabase/functions/generate-reply/index.ts')
g = gen.read_text()

old_import = 'import { buildCitationMetadata } from "../_shared/citation-lineage.ts";\n'
new_import = old_import + 'import { buildInheritedTransformCitationMetadata, buildPriorGroundedTransformBlock, resolvePriorGroundedTransform } from "../_shared/prior-grounded-transform.ts";\n'
if new_import not in g and old_import in g:
    g = g.replace(old_import, new_import, 1)

old = '''  const _pr5History = deriveConversationHistorySignals(
    _pr5HistoryRows ?? [],
    _pr5VisitorTurnCount ?? 0,
  );
  const _conversationContinuityBlock = buildCanonicalContinuityBlock(_pr5HistoryRows ?? []);'''
new = '''  const _pr5History = deriveConversationHistorySignals(
    _pr5HistoryRows ?? [],
    _pr5VisitorTurnCount ?? 0,
  );
  const _priorGroundedTransform = resolvePriorGroundedTransform(
    _h1LastMsg,
    _pr5HistoryRows ?? [],
  );
  const _conversationContinuityBlock = buildCanonicalContinuityBlock(_pr5HistoryRows ?? []);'''
if old in g:
    g = g.replace(old, new, 1)

old = '  const _g1SkipKB = _pr5GreetingOrTrivial;'
new = '''  // A verified transform reuses the immutable evidence authority of the prior
  // grounded answer. It must not perform a second/current KB retrieval because
  // that can select different evidence and falsely reject a faithful transform.
  const _g1SkipKB = _pr5GreetingOrTrivial || Boolean(_priorGroundedTransform);'''
if old in g:
    g = g.replace(old, new, 1)

old = '''    buildMaskedContextBlock(customerContext, opaqueCustomerRef),
    buildRagBlock(ragResult),
  ].filter((s) => s && s.length > 0).join("\\n\\n");'''
new = '''    buildMaskedContextBlock(customerContext, opaqueCustomerRef),
    buildRagBlock(ragResult),
    buildPriorGroundedTransformBlock(_priorGroundedTransform),
  ].filter((s) => s && s.length > 0).join("\\n\\n");'''
if old in g:
    g = g.replace(old, new, 1)

old = '''  const citationMeta = finalPromptChunks.length > 0
    ? buildCitationMetadata(
        finalPromptChunks,
        ragResult?.llm_context?.selected_document_id ?? null,
      )
    : null;
  if (flags.ENABLE_KB && !_g1SkipKB && finalPromptChunks.length > 0 && !citationMeta) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: false, error: "citation_lineage_unavailable" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }'''
new = '''  const citationMeta = _priorGroundedTransform
    ? buildInheritedTransformCitationMetadata(_priorGroundedTransform)
    : finalPromptChunks.length > 0
      ? buildCitationMetadata(
          finalPromptChunks,
          ragResult?.llm_context?.selected_document_id ?? null,
        )
      : null;
  if (_priorGroundedTransform && !citationMeta) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: false, error: "prior_grounded_transform_lineage_unavailable" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  if (flags.ENABLE_KB && !_g1SkipKB && finalPromptChunks.length > 0 && !citationMeta) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: false, error: "citation_lineage_unavailable" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }'''
if old in g:
    g = g.replace(old, new, 1)

gen.write_text(g)
