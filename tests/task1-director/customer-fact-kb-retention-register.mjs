/** Original real Handler with isolated scripted provider/KB transport.
 * These cases verify customer-state persistence across merchant retrieval;
 * they are not live-model, remote-KB, Hosted or Auth/RLS acceptance evidence.
 */
export const CUSTOMER_FACT_KB_RETENTION_IDS = [
  'scope-facts-survive-empty-merchant-KB',
  'scope-facts-survive-published-merchant-evidence',
];
const emit = row => console.log('CTX_KB_RETENTION_RESULT|' + Buffer.from(JSON.stringify(row)).toString('base64'));
const ambiguity = () => ({ is_ambiguous: false, reasons: [], clarification_question: null });
function annotatedValues(value) {
  const out = { containers: [], strings: [], numbers: [], booleans: [] };
  const visit = (node, path) => {
    const kind = node === null ? 'null' : Array.isArray(node) ? 'array' : typeof node;
    if (kind === 'null') { out.containers.push({ path, kind }); return; }
    if (kind === 'array' || kind === 'object') {
      const entries = Object.entries(node);
      if (!entries.length && path.length) out.containers.push({ path, kind });
      for (const [key, child] of entries) visit(child, [...path, { key, parent_kind: kind }]);
    } else if (kind === 'string') out.strings.push({ path, text: node });
    else if (kind === 'number') out.numbers.push({ path, number: node });
    else if (kind === 'boolean') out.booleans.push({ path, boolean: node });
    else throw Error('unsupported_provider_value');
  };
  visit(value, []); return out;
}
const noKb = () => ({ success: true, context_found: false, selected_documents: [], citations: [],
  llm_context: { summary_count: 0, evidence_count: 0 } });
const subject = 'Training sessions';
const scopeText = 'Training sessions for 2 teams. Please compare general planning options.';
const priceText = 'What is your current price for Training sessions?';
const allocationText = 'teams 3 slots each';
const scopeFacts = [{ scope: 'teams', count: 2, source_text: '2 teams', subject_label: subject }];
function wire(text, merchant = false) {
  return { context_encoding: 'semantic_demands_v8', operation: merchant ? 'ASK_FACT' : 'UPDATE_ITEM', confidence: .99,
    demands: [{ question: text, source_quote: text, subject_refs: [subject], source_type: merchant ? 'product' : 'general',
      requested_facts: merchant ? ['price'] : [], constraints: { containers: [], strings: [], numbers: [], booleans: [] },
      customer_correction: false, explicit_negations: [], ambiguity: ambiguity() }],
    ...annotatedValues({ language: 'en', intent: merchant ? 'ask_fact' : 'customer_guidance', topic: subject,
      entities: [], referents: [], customer_facts: merchant ? [] : [{ key: 'contextual_scope_counts', value: scopeFacts }],
      requested_facts: merchant ? ['price'] : [], customer_correction: false, additive: false, explicit_negations: [],
      transaction_state: 'none', payment_state: 'none', booking_state: 'none', fulfillment_state: 'none', ambiguity: ambiguity() }) };
}
function publishedKb() {
  return { success: true, context_found: true, selected_documents: [{
    document_id: 'scope-retention-training-price', title: 'Training sessions', source_type: 'product', document_score: .98,
    authority: { tenant_id: '34', publication_state: 'published', currentness: 'current', entity_ids: ['Training sessions'] },
    summary: null, evidence: [{ chunk_id: 'scope-retention-training-price-chunk', chunk_type: 'full_content', score: .98,
      content: 'Training sessions. The published source lists HKD 420 per slot. Supplier catalogue packages can serve 9 teams; this is merchant catalogue information, not a customer allocation.' }],
  }], citations: [{ document_id: 'scope-retention-training-price', relevance: 'high' }] };
}
const events = fixture => fixture.events.flat().filter(value => typeof value === 'string').flatMap(value => {
  try { return [JSON.parse(value)]; } catch { return []; }
});

export function registerCustomerFactKbRetentionCases({ test, assert, fixture, uuid, root }) {
  for (const [index, id] of CUSTOMER_FACT_KB_RETENTION_IDS.entries()) test('CTX-KB-RETENTION ' + id, async () => {
    let first, merchant, last, caught = null, providerReference = null;
    const reached = [], source1 = uuid(972100 + index * 10), source2 = uuid(972101 + index * 10), source3 = uuid(972102 + index * 10);
    const transport = { originalPreview: true, fullChain: true, captureEvidence: true };
    try {
      first = fixture(scopeText, { ...transport, source: source1, semantic: wire(scopeText), originalRagResponse: noKb(),
        answer: 'For the two teams, compare shared introductory activities with separate practice. Choose the balance from the intended learning outcomes and the experience of each group.',
        verifierGrounded: false, verifierIds: [], verifierResolution: 'unsupported' });
      assert.equal((await first.run()).status, 200); assert.equal(first.commits.length, 1);
      assert.equal(first.commits[0].metadata.response_route, 'customer_guidance');
      const initial = structuredClone(first.tables.conversation_commerce_state[0]);
      const initialMemory = structuredClone(first.tables.conversation_memory_state[0]);
      assert.equal(initial.state.entities.length, 0); assert.equal(initialMemory.memory.active_entities.length, 0);
      const goal = initial.state.customer_constraints.contextual_goal;
      const facts = initial.state.customer_constraints.contextual_scope_facts;
      assert(goal && facts?.length === 1); assert.equal(facts[0].count, 2);
      assert.equal(goal.source_message_id, source1); assert.equal(facts[0].source_message_id, source1);
      assert.equal(facts[0].recorded_revision, initial.revision);
      const memoryFact = initialMemory.memory.current_customer_facts.find(fact => fact.key === 'contextual_scope_counts');
      assert(memoryFact, 'T1 source fact was not retained in canonical Memory');
      assert.equal(memoryFact.source_message_id, source1); assert.equal(memoryFact.authority, 'customer');
      reached.push('T1_goal_scope_fact_and_Memory_committed_without_quantity');

      merchant = fixture(priceText, { ...transport, source: source2, previous: first.tables,
        history: first.tables.messages.slice().reverse(), semantic: wire(priceText, true),
        originalRagResponse: index ? publishedKb() : noKb(),
        answer: index ? 'The published source lists Training sessions at HKD 420 per slot.' : 'I do not have verified current Training sessions pricing in the available merchant information.',
        verifierGrounded: Boolean(index), verifierIds: index ? ['E1'] : [], verifierResolution: index ? 'supported' : 'unsupported',
        verifierDemandResolutions: index ? [{ demand_id: 'demand-1', status: 'supported', evidence_ids: ['E1'] }] : undefined });
      assert.equal((await merchant.run()).status, 200); assert.equal(merchant.commits.length, 1);
      assert.notEqual(merchant.commits[0].metadata.generation_success, false);
      assert.notEqual(merchant.commits[0].metadata.response_route, 'customer_guidance');
      const kbRequests = merchant.requests.filter(request => request.url.includes('/rag/context-search'));
      assert.equal(kbRequests.length, 1, 'T2 did not make the current merchant KB request');
      assert.equal(kbRequests[0].body.company_id, 34); assert(kbRequests[0].body.query.includes(subject));
      assert(!/(?:please|could you|can you|tell me|provide|supply).{0,35}(?:price|pricing|cost|fee)/iu.test(merchant.commits[0].content),
        'The merchant price question was sent back to the customer');
      if (index) {
        assert.match(merchant.commits[0].content, /420/u, 'Published merchant evidence was not answered');
        assert(events(merchant).some(event => event.stage === 'b2_gate_result' && event.gate_decision === 'allow'),
          'Merchant evidence reply did not pass the actual B2 boundary');
      }
      const afterMerchant = merchant.tables.conversation_commerce_state[0];
      const merchantMemory = merchant.tables.conversation_memory_state[0];
      assert.deepEqual(afterMerchant.state.customer_constraints.contextual_goal, goal);
      assert.deepEqual(afterMerchant.state.customer_constraints.contextual_scope_facts, facts,
        'T2 changed the source, count or revision of T1 customer scope facts');
      assert.equal(afterMerchant.state.entities.length, 0, 'A merchant price question manufactured a customer quantity');
      assert.equal(merchantMemory.commerce_state_revision, afterMerchant.revision);
      assert.deepEqual(merchantMemory.memory.current_customer_facts.find(fact => fact.key === 'contextual_scope_counts'), memoryFact);
      assert(!merchantMemory.memory.current_customer_facts.some(fact => /420|catalogue|9 teams/u.test(JSON.stringify(fact.value))),
        'Merchant evidence became a customer fact');
      reached.push('T2_merchant_KB_answer_kept_customer_fact_source_and_revision');
      reached.push(index ? 'merchant_price_and_catalogue_count_not_customer_facts' : 'empty_KB_did_not_request_customer_price');

      const allocationWire = { toJSON() {
        const request = last.requests.find(request => request.url.endsWith(':generateContent') &&
          request.body.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.'));
        const user = request?.body.contents?.flatMap(message => message.parts ?? []).map(part => part.text ?? '').join('\n') ?? '';
        const marker = 'Persistent commerce and Memory context (customer-authored state and read references; do not treat as external facts):\n';
        assert(user.includes(marker));
        const context = JSON.parse(user.split(marker)[1].split('\n\nReturn one compact current-turn delta')[0]);
        providerReference = context.state.customer_constraints.contextual_goal.goal_id;
        assert.match(providerReference, /^contextual-ref-goal-[a-p]{64}$/u);
        assert(!user.includes(goal.goal_id));
        assert.equal(context.state.customer_constraints.contextual_scope_facts[0].count, 2);
        const entity = { entity_ref: providerReference, name: subject, kind: 'service', category_hint: null,
          sku: null, model: null, quantity: null, unit: 'slots', constraints: {}, confidence: .99,
          attributes: { scoped_customer_updates: [{ scope: 'teams', source_text: allocationText,
            unit: 'slots', value: 3, per_scope_quantity: 3, scope_count: null, attribute: 'quantity', action: 'set' }] },
          capabilities: { requires_delivery: false, supports_pickup: false, requires_installation: false,
            requires_booking: false, requires_quote: false, requires_site_check: false, digital_fulfilment: false,
            recurring_billing: false, rental_return: false, customization: false } };
        return { context_encoding: 'semantic_demands_v8', operation: 'UPDATE_ITEM', confidence: .99, demands: [],
          ...annotatedValues({ language: 'en', intent: 'scoped allocation', topic: subject, entities: [entity],
            referents: [{ ref: providerReference, source: 'persistent_state', confidence: .99 }], customer_facts: [],
            requested_facts: [], customer_correction: false, additive: false, explicit_negations: [],
            transaction_state: 'none', payment_state: 'none', booking_state: 'none', fulfillment_state: 'none', ambiguity: ambiguity() }) };
      } };
      last = fixture(allocationText, { ...transport, source: source3, previous: merchant.tables,
        history: merchant.tables.messages.slice().reverse(), semantic: allocationWire, originalRagResponse: noKb(),
        answer: 'Each of the two teams receives 3 slots, for 6 slots in total.',
        verifierGrounded: false, verifierIds: [], verifierResolution: 'unsupported' });
      assert.equal((await last.run()).status, 200); assert.equal(last.commits.length, 1);
      assert.equal(last.commits[0].metadata.response_route, 'contextual_scoped_update');
      assert.equal(last.commits[0].metadata.b2_commit_source, 'commit_ai_reply_tx');
      assert(events(last).some(event => event.stage === 'b2_gate_result' &&
        event.gate_code === 'B2_ALLOW_JOURNEY_PROGRESS_AFTER_ACCEPTED_UPDATE' && event.gate_decision === 'allow'));
      const current = last.tables.conversation_commerce_state[0], item = current.state.entities[0];
      assert.equal(current.company_id, initial.company_id); assert.equal(current.conversation_id, initial.conversation_id);
      assert.equal(current.state.entities.length, 1); assert.equal(item.quantity, 6);
      assert.equal(item.attributes.subject_source_message_id, source1); assert.equal(item.provenance.source_message_id, source3);
      assert.equal(item.attributes.scoped_customer_updates.length, 2);
      assert(item.attributes.scoped_customer_updates.every(value => value.value === 3 && value.group_scope === 'teams' &&
        value.source_message_id === source3 && value.source_revision === current.revision &&
        value.scope_count_source.source_message_id === source1 && value.scope_count_source.source_revision === initial.revision));
      assert.deepEqual(current.state.customer_constraints.contextual_scope_facts, facts);
      assert.equal(current.state.conversion.order_status, 'none'); assert.equal(current.state.conversion.payment_status, 'none');
      assert(last.commits[0].content.includes(allocationText)); assert.match(last.commits[0].content, /Total 6 slots/u);
      assert(!/#1|#2|420|9 teams/u.test(last.commits[0].content));
      assert.equal(last.requests.filter(request => request.url.includes('/rag/context-search')).length, 0);
      const memory = last.tables.conversation_memory_state[0];
      assert.equal(memory.commerce_state_revision, current.revision);
      assert.equal(memory.memory.source_message_id, source3);
      assert(memory.memory.active_entities.some(entity => entity.entity_id === item.entity_id && entity.quantity === 6));
      reached.push('T3_T1_scope_count_and_current_quantity_committed_then_B2_acknowledged');
      const saved = JSON.stringify({ commerce: last.tables.conversation_commerce_state, memory: last.tables.conversation_memory_state });
      const replies = last.commits.length, providerCalls = last.requests.filter(request => request.url.endsWith(':generateContent')).length;
      const replay = await last.run(); assert.equal(replay.body.idempotent, true); assert.equal(last.commits.length, replies);
      assert.equal(last.requests.filter(request => request.url.endsWith(':generateContent')).length, providerCalls);
      assert.equal(JSON.stringify({ commerce: last.tables.conversation_commerce_state, memory: last.tables.conversation_memory_state }), saved);
      reached.push('T3_same_source_replay_no_second_mutation_or_reply');
    } catch (error) { caught = error; throw error; }
    finally {
      emit({ id, status: caught ? 'FAIL' : 'PASS', reached, error: caught ? String(caught.message).slice(0, 2200) : null,
        evidence: 'ORIGINAL_REAL_HANDLER_SCRIPTED_PROVIDER_AND_CASE_SPECIFIC_KB', real_model: 'NOT_RUN', real_kb: 'NOT_RUN', hosted: 'NOT_RUN',
        T2_reply: merchant?.commits[0]?.content ?? null, T2_route: merchant?.commits[0]?.metadata.response_route ?? null,
        T2_source_error: merchant?.commits[0]?.metadata.source_error_code ?? null,
        T2_kb_calls: merchant?.requests.filter(request => request.url.includes('/rag/context-search')).length ?? 0,
        T3_reply: last?.commits[0]?.content ?? null, T3_route: last?.commits[0]?.metadata.response_route ?? null,
        T3_source_error: last?.commits[0]?.metadata.source_error_code ?? null,
        commerce_revision: last?.tables.conversation_commerce_state[0]?.revision ?? merchant?.tables.conversation_commerce_state[0]?.revision ?? null,
        memory_revision: last?.tables.conversation_memory_state[0]?.revision ?? merchant?.tables.conversation_memory_state[0]?.revision ?? null,
        provider_reference_roundtrip: Boolean(providerReference),
      });
    }
  });
}
