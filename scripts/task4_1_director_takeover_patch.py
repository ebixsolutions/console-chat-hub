from pathlib import Path

root = Path('.')
helper = root / 'supabase/functions/_shared/prior-grounded-transform.ts'
gen = root / 'supabase/functions/generate-reply/index.ts'

h = helper.read_text()
marker = '''export function buildPriorGroundedTransformBlock(
  context: PriorGroundedTransformContext | null,
): string {'''
assert marker in h

insert = '''export function buildPriorGroundedTransformGenerationSystem(
  context: PriorGroundedTransformContext | null,
): string {
  if (!context) return "";
  return [
    "You are a customer-service response transformer, not a factual answering system.",
    "The previously verified grounded answer below is the ONLY factual authority for this turn.",
    "Transform that answer exactly as requested by the latest customer instruction.",
    "Do not use facts from conversation history, CRM/customer context, general knowledge, policies, titles, or any other prompt section.",
    "Do not add examples, explanations, caveats, eligibility conditions, jurisdictions, procedures, prices, dates, durations, quantities, model details, or recommendations unless they already appear in the prior grounded answer.",
    "Do not say that you checked, searched, know, recommend, infer, or verified anything beyond that prior answer.",
    "Return only the transformed customer-facing answer. No preface, no meta-commentary, no source discussion.",
    buildPriorGroundedTransformBlock(context),
  ].join("\\n\\n");
}

export function buildPriorGroundedTransformGenerationUser(
  latestInstruction: string,
): string {
  return [
    "Latest transformation instruction:",
    latestInstruction.normalize("NFKC").trim().slice(0, 1000),
    "",
    "Perform only this transformation. Do not answer any other question or add any new factual content.",
  ].join("\\n");
}

export function buildPriorGroundedTransformRetrySystem(
  context: PriorGroundedTransformContext | null,
): string {
  const base = buildPriorGroundedTransformGenerationSystem(context);
  if (!base) return "";
  return [
    base,
    "STRICT RETRY: The previous transformed draft was rejected by the grounding verifier.",
    "Use shorter wording and copy factual nouns, numbers, product categories, jurisdictions, and conditions directly from the prior grounded answer whenever possible.",
    "Do not introduce even plausible explanatory facts that are absent from the prior grounded answer.",
  ].join("\\n\\n");
}

'''
h = h.replace(marker, insert + marker, 1)
helper.write_text(h)

g = gen.read_text()
g = g.replace(
'''import { buildInheritedTransformCitationMetadata, buildPriorGroundedTransformBlock, resolvePriorGroundedTransform } from "../_shared/prior-grounded-transform.ts";''',
'''import { buildInheritedTransformCitationMetadata, buildPriorGroundedTransformBlock, buildPriorGroundedTransformGenerationSystem, buildPriorGroundedTransformGenerationUser, buildPriorGroundedTransformRetrySystem, resolvePriorGroundedTransform } from "../_shared/prior-grounded-transform.ts";''',
1,
)
assert 'buildPriorGroundedTransformGenerationSystem' in g

g = g.replace('''  if (flags.ENABLE_COACH) {''','''  if (flags.ENABLE_COACH && !_priorGroundedTransform) {''',1)

old_prompt = '''  const finalSystemPrompt = [
    basePrompt,
    CUSTOMER_CONVERSATION_POLICY,
    _conversationContinuityBlock,
    _customerAdvisoryBlock,
    buildMaskedContextBlock(customerContext, opaqueCustomerRef),
    buildRagBlock(ragResult),
    buildPriorGroundedTransformBlock(_priorGroundedTransform),
  ].filter((s) => s && s.length > 0).join("\\n\\n");'''
new_prompt = '''  const finalSystemPrompt = _priorGroundedTransform
    ? buildPriorGroundedTransformGenerationSystem(_priorGroundedTransform)
    : [
        basePrompt,
        CUSTOMER_CONVERSATION_POLICY,
        _conversationContinuityBlock,
        _customerAdvisoryBlock,
        buildMaskedContextBlock(customerContext, opaqueCustomerRef),
        buildRagBlock(ragResult),
      ].filter((s) => s && s.length > 0).join("\\n\\n");'''
assert old_prompt in g
g = g.replace(old_prompt, new_prompt, 1)

old_call = '''  const llm = await callModel({
    purpose: "generation",
    system: finalSystemPrompt,
    user: buildRouterConversationInput(modelMessages),
    maxTokens: resolveGenerationMaxTokens(),
    operationId: `generate-reply:orchestration:${conversation_id}:${source_message_id}`,
    companyId:
      typeof conversation.company_id === "string" && conversation.company_id.length > 0
        ? conversation.company_id
        : null,
    conversationId: conversation_id,
    tag: "generate-reply-orchestration",
    responseFormat: "text",
  });

  if (!llm.ok) {'''
new_call = '''  const _generationCompanyId =
    typeof conversation.company_id === "string" && conversation.company_id.length > 0
      ? conversation.company_id
      : null;
  const _generationUserInput = _priorGroundedTransform
    ? buildPriorGroundedTransformGenerationUser(_h1LastMsg)
    : buildRouterConversationInput(modelMessages);

  let llm = await callModel({
    purpose: "generation",
    system: finalSystemPrompt,
    user: _generationUserInput,
    maxTokens: resolveGenerationMaxTokens(),
    operationId: `generate-reply:orchestration:${conversation_id}:${source_message_id}`,
    companyId: _generationCompanyId,
    conversationId: conversation_id,
    tag: "generate-reply-orchestration",
    responseFormat: "text",
  });

  // A verifier rejection on a prior-grounded transform is not yet proof of an
  // upstream/system outage. Retry once with stricter factual isolation. Both
  // drafts are still gated by the same exact + semantic grounding verifier.
  if (_priorGroundedTransform && !llm.ok && llm.code === "LLM_INVALID_OUTPUT") {
    llm = await callModel({
      purpose: "generation",
      system: buildPriorGroundedTransformRetrySystem(_priorGroundedTransform),
      user: _generationUserInput,
      maxTokens: resolveGenerationMaxTokens(),
      operationId: `generate-reply:orchestration:${conversation_id}:${source_message_id}:transform-retry`,
      companyId: _generationCompanyId,
      conversationId: conversation_id,
      tag: "generate-reply-orchestration-transform-retry",
      responseFormat: "text",
    });
  }

  if (!llm.ok) {'''
assert old_call in g
g = g.replace(old_call, new_call, 1)
gen.write_text(g)

print('TASK4_1_PATCH=APPLIED')