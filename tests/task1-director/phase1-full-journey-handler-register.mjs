/**
 * The unchanged complete handler, decoder, runtime, Memory and B2 execute here.
 * Only the existing external SDK/HTTP boundaries are scripted. This file proves
 * offline orchestration and assertions, never real-model usefulness, Hosted,
 * remote KB authority, authenticated RLS, or concurrent database acceptance.
 * Each sequence carries the previous turn's actual persisted tables forward.
 */
const BUSINESS_CONTEXTS = [
  { id: 'catering', subject: 'Festival catering', unit: 'trays', group: 'tables', single: 'counter',
    detail: 'dietary_priority', value: 'labelled vegetarian choices',
    answer: 'For two tables and one counter, compare individually labelled trays with shared serving. Labelled vegetarian choices help guests identify suitable food; separate serving tools reduce mix-ups. Confirm ingredients with the supplier before selecting a menu.' },
  { id: 'subscriptions', subject: 'Workspace subscriptions', unit: 'licences', group: 'departments', single: 'reception',
    detail: 'renewal_preference', value: 'manual renewal',
    answer: 'For two departments and one reception, compare individual access with shared administration. Manual renewal gives the team an explicit review point; check permission management and account recovery before choosing a plan. Published plan terms still need verification.' },
  { id: 'rentals', subject: 'Event equipment rental', unit: 'kits', group: 'booths', single: 'stage',
    detail: 'return_preference', value: 'one coordinated return',
    answer: 'For two booths and one stage, compare separate equipment kits with a shared reserve. One coordinated return can simplify collection, while separate kits reduce contention. Confirm compatibility and the supplier’s return terms before selecting equipment.' },
];
const emptyKb = () => ({ success: true, context_found: false, selected_documents: [], citations: [] });
const ambiguity = () => ({ is_ambiguous: false, reasons: [], clarification_question: null });
const capabilities = () => Object.fromEntries(['requires_delivery', 'supports_pickup', 'requires_installation',
  'requires_booking', 'requires_quote', 'requires_site_check', 'digital_fulfilment',
  'recurring_billing', 'rental_return', 'customization'].map(key => [key, false]));
function annotated(value) {
  const result = { containers: [], strings: [], numbers: [], booleans: [] };
  function visit(item, path) {
    const kind = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
    if (kind === 'object' || kind === 'array' || kind === 'null') {
      const entries = item === null ? [] : Object.entries(item);
      if (!entries.length && path.length) result.containers.push({ path, kind });
      for (const [key, child] of entries) visit(child, [...path, { key, parent_kind: kind }]);
    } else if (kind === 'string') result.strings.push({ path, text: item });
    else if (kind === 'number') result.numbers.push({ path, number: item });
    else if (kind === 'boolean') result.booleans.push({ path, boolean: item });
    else throw new Error('Unsupported provider fixture value');
  }
  visit(value, []);
  return result;
}
function demand(text, subject, facts = [], source_type = 'general') {
  return { question: text, source_quote: text, subject_refs: subject ? [subject] : [], source_type,
    requested_facts: facts, constraints: {}, customer_correction: false, explicit_negations: [], ambiguity: ambiguity() };
}
function wire(delta, operation = 'UPDATE_ITEM') {
  const { demands = [], ...rest } = delta;
  return { context_encoding: 'semantic_demands_v8', operation, confidence: .99,
    demands: demands.map(row => ({ ...row, constraints: annotated(row.constraints ?? {}) })),
    ...annotated({ language: 'en', intent: 'customer_guidance', topic: null, entities: [], referents: [],
      customer_facts: [], requested_facts: [], customer_correction: false, additive: false,
      explicit_negations: [], transaction_state: 'none', payment_state: 'none', booking_state: 'none',
      fulfillment_state: 'none', ambiguity: ambiguity(), ...rest }) };
}
function proposalEntity(context, ref, rows = [], extra = {}) {
  return { entity_ref: ref, name: context.subject, kind: 'service', category_hint: null, sku: null,
    model: null, quantity: null, unit: context.unit,
    attributes: rows.length ? { scoped_customer_updates: rows } : {}, constraints: {},
    capabilities: capabilities(), confidence: .99, ...extra };
}
function sourceDocument(model, { price = 1280, stock = 7, tenant = '34', currentness = 'current',
  publication = 'published', id = 'journey-product-' + model } = {}) {
  return { document_id: id, title: model, source_type: 'Product', document_score: .99,
    authority: { tenant_id: tenant, publication_state: publication, currentness,
      entity_ids: [model], regions: ['hong_kong'], version: 'offline-journey-v1' },
    evidence: [{ document_id: id, chunk_id: id + '-full', chunk_type: 'full_content', score: .99,
      content: `Model: ${model}\nBrand: Fixture Events\nDescription: Portable event equipment kit\nFeatures: detachable supports and a padded transport case\nPrice: HK$${price}\nStock: ${stock}` }] };
}
const rag = (...documents) => ({ success: true, context_found: documents.length > 0, selected_documents: documents, citations: [] });

export function registerFullJourneyHandlerTests({ test, assert, fixture, uuid, root }) {
  let testIndex = 0;
  const labels = [];
  function register(label, originals, contextIds, callback) {
    const index = testIndex++; labels.push(label);
    test('P1 full journey: ' + label, async () => {
      const report = { label, original_cases: originals, business_contexts: contextIds,
        evidence: 'COMPLETE_HANDLER_WITH_SCRIPTED_EXTERNAL_TRANSPORT',
        real_model: 'NOT_RUN', remote_kb: 'NOT_RUN', hosted: 'NOT_RUN', turns: [] };
      let error;
      const dialogue = makeDialogue(index, report);
      try { await callback(dialogue, report); }
      catch (caught) {
        error = caught;
        const last = dialogue.last;
        if (last) report.failure_context = { events: last.events.slice(-15), logs: last.logs.slice(-4),
          commerce: last.tables.conversation_commerce_state[0], memory: last.tables.conversation_memory_state[0],
          persistence_requests: last.requests.filter(row => /c3_commit_conversation_memory_tx|apply_commerce/.test(row.url)) };
        throw caught;
      }
      finally {
        console.log('P1_FULL_JOURNEY_RESULT|' + Buffer.from(JSON.stringify({ ...report,
          status: error ? 'FAIL' : 'PASS', error: error ? String(error.message ?? error).slice(0, 2400) : null })).toString('base64'));
      }
    });
  }
  function state(f) { return f.tables.conversation_commerce_state[0]?.state; }
  function item(f, subject) {
    const matches = state(f)?.entities.filter(entity => entity.attributes.product_name === subject) ?? [];
    assert.equal(matches.length, 1, 'Expected one canonical source-owned subject: ' + subject + '; actual=' + JSON.stringify(state(f)?.entities));
    return matches[0];
  }
  function noTransaction(f, expectedHistoricalQuote) {
    const current = state(f); assert(current, 'No canonical state was persisted');
    assert.equal(current.conversion.order_status, 'none');
    assert.equal(current.conversion.payment_status, 'none');
    assert.equal(current.conversion.quotation_status, 'none');
    // No active quotation/order/payment is allowed. Only a specifically
    // expected, customer-attributed historical record may coexist with this.
    if(!expectedHistoricalQuote){
      assert.deepEqual(current.quotes, []);
    }else{
      assert.equal(current.quotes.length,1);
      const q=current.quotes[0],e=expectedHistoricalQuote;
      assert.equal(q.quote_id,'customer:'+e.source_message_id+':0');
      assert.equal(q.entity_id,null);
      assert.equal(q.amount,e.amount);
      assert.equal(q.currency,e.currency);
      assert.equal(q.quote_type,'customer_reported_historical');
      assert.equal(q.validity_status,'unknown');
      assert.equal(q.source_label,'customer_reported');
      assert.deepEqual(q.conditions,{historical:true,unverified:true});
      assert.equal(q.provenance.source_type,'customer');
      assert.equal(q.provenance.source_message_id,e.source_message_id);
      assert(Number.isFinite(Date.parse(q.provenance.recorded_at)));
    }
  }
  function modelRequests(f) { return f.requests.filter(request => request.url.endsWith(':generateContent')); }
  function generated(f) {
    return modelRequests(f).filter(request => !request.body.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.') &&
      !request.body.generationConfig?.responseSchema?.properties?.grounded);
  }
  function gates(f) {
    return f.events.flat().filter(value => typeof value === 'string').flatMap(value => {
      try { return [JSON.parse(value)]; } catch { return []; }
    }).filter(value => value.stage === 'b2_gate_result');
  }
  function outbound(f) {
    const request = modelRequests(f).find(row => row.body.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.'));
    assert(request, 'The actual semantic producer was not called');
    const text = request.body.contents.flatMap(message => message.parts ?? []).map(part => part.text ?? '').join('\n');
    const marker = 'Persistent commerce and Memory context (customer-authored state and read references; do not treat as external facts):\n';
    assert(text.includes(marker), 'The interpreter did not receive the committed source projection');
    return JSON.parse(text.split(marker)[1].split('\n\nReturn one compact current-turn delta')[0]);
  }
  function entityReference(f, context) {
    const projected = outbound(f).state.entities.filter(entity => entity.attributes.product_name === context.subject);
    assert.equal(projected.length, 1, 'Source projection did not retain ' + context.subject + ': ' + JSON.stringify(outbound(f).state.entities));
    // The current contextual goal has a request-bound opaque reference. Older
    // subjects can still be named by their exact visible customer-owned label;
    // never copy a redacted ID or recover a hidden canonical ID in the fixture.
    return /^contextual-ref-/u.test(projected[0].entity_id) ? projected[0].entity_id : context.subject;
  }
  function delivered(f, result, source, expectedHistoricalQuote) {
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(f.commits.length, 1, JSON.stringify({ result, commits: f.commits, gates: gates(f) }));
    const reply = f.commits[0];
    assert.notEqual(reply.metadata.generation_success, false, JSON.stringify({ result, metadata: reply.metadata }));
    assert(reply.content.trim().length > 0, 'An empty reply escaped the handler');
    assert.equal(reply.metadata.b2_source_message_id, source);
    assert.equal(reply.metadata.b2_commit_source, 'commit_ai_reply_tx');
    assert.equal(reply.conversation_id, uuid(2));
    assert.equal(f.tables.messages.filter(message => message.id === reply.id).length, 1);
    assert(gates(f).some(gate => gate.source_message_id === source && gate.gate_decision === 'allow' && gate.commit_attempted),
      'The final reply did not pass the real B2 persistence gate: ' + JSON.stringify(gates(f)));
    noTransaction(f,expectedHistoricalQuote);
    return reply;
  }
  function memoryParity(f) {
    const commerce = f.tables.conversation_commerce_state[0], memory = f.tables.conversation_memory_state[0];
    assert(memory, 'No durable canonical Memory row');
    assert.equal(memory.commerce_state_revision, commerce.revision);
    assert.equal(memory.memory.company_id, commerce.company_id);
    assert.equal(memory.memory.conversation_id, commerce.conversation_id);
    for (const entity of commerce.state.entities.filter(entity => !['cancelled', 'deferred'].includes(entity.status))) {
      const saved = memory.memory.active_entities.find(candidate => candidate.entity_id === entity.entity_id);
      assert(saved, 'Canonical Memory lost an active source-owned subject');
      assert.equal(saved.quantity, entity.quantity);
    }
  }
  function makeDialogue(index, report) {
    let previous = null, ordinal = 0;
    const turns = [];
    return {
      get last() { return previous; }, get turns() { return turns; },
      async ask(spec) {
        const source = uuid(990000 + index * 100 + ++ordinal);
        const before = previous ? structuredClone(previous.tables.conversation_commerce_state[0]) : null;
        let f;
        const semantic = { toJSON() {
          try { return typeof spec.reading === 'function' ? spec.reading(f) : spec.reading; }
          catch (error) { (report.fixture_errors ??= []).push(String(error.message ?? error)); throw error; }
        } };
        const history = previous ? [...previous.tables.messages].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)) : undefined;
        f = fixture(spec.text, { source, originalPreview: true, fullChain: true, captureEvidence: true,
          ...(previous ? { previous: previous.tables, history,
            human: previous.tables.conversations[0].status === 'human_control' } : {}),
          semantic, answer: spec.answer ?? 'Untrusted fixture draft must not override canonical state.',
          originalRagResponse: spec.kb ?? emptyKb(),
          verifierGrounded: spec.verifierGrounded ?? false, verifierIds: spec.verifierIds ?? [],
          verifierResolution: spec.verifierGrounded ? 'supported' : 'unsupported',
          ...(spec.options ?? {}) });
        const result = await f.run();
        const entry = { f, result, source, before, text: spec.text };
        turns.push(entry); previous = f;
        report.turns.push({ ordinal, source, text: spec.text, http: result.status,
          route: f.commits[0]?.metadata.response_route ?? result.body.response_route ?? null,
          commerce_revision: f.tables.conversation_commerce_state[0]?.revision ?? null,
          memory_revision: f.tables.conversation_memory_state[0]?.revision ?? null,
          reply: f.commits[0]?.content ?? result.body.reply ?? null,
          model_requests: modelRequests(f).length, kb_requests: f.requests.filter(row => row.url.includes('context-search')).length });
        if (spec.expected !== 'handoff' && spec.expected !== 'suppressed' && spec.expected !== 'negative') delivered(f, result, source,
          spec.expectedHistoricalQuote ? {...spec.expectedHistoricalQuote,source_message_id:spec.expectedHistoricalQuote.source_message_id??source}:undefined);
        if (spec.expectAdvice) {
          assert.equal(f.commits[0].metadata.response_route, 'customer_guidance');
          assert.equal(f.commits[0].content, spec.answer);
          assert.equal(f.requests.filter(row => row.url.includes('context-search')).length, 0);
          assert(JSON.stringify(generated(f)[0]?.body).includes(spec.text), 'Accepted detail vanished before the actual guidance request');
        }
        return entry;
      },
    };
  }
  function scope(context, { detail = false } = {}) {
    const text = `${context.subject} for 2 ${context.group} and 1 ${context.single}. ` +
      (detail ? `Our ${context.detail.replaceAll('_', ' ')} is ${context.value}. ` : '') +
      'Please compare the planning trade-offs.';
    const facts = [{ key: 'contextual_scope_counts', value: [
      { scope: context.group, count: 2, source_text: `2 ${context.group}`, subject_label: context.subject },
      { scope: context.single, count: 1, source_text: `1 ${context.single}`, subject_label: context.subject },
    ] }, ...(detail ? [{ key: context.detail, value: context.value }] : [])];
    return { text, answer: context.answer,
      reading: wire({ topic: context.subject, customer_facts: facts, demands: [demand(text, context.subject)] }) };
  }
  function allocation(context, each = 1) {
    const text = `${context.single} 1 ${context.unit}, ${context.group} ${each} ${context.unit} each`;
    return { text, reading: f => {
      const goal = outbound(f).state.customer_constraints.contextual_goal;
      assert.equal(goal.subject_label, context.subject); assert.match(goal.goal_id, /^contextual-ref-goal-/u);
      return wire({ intent: 'scoped allocation', topic: context.subject,
        entities: [proposalEntity(context, goal.goal_id, [
          { scope: context.single, source_text: `${context.single} 1 ${context.unit}`, unit: context.unit, value: 1, attribute: 'quantity', action: 'set' },
          { scope: context.group, source_text: `${context.group} ${each} ${context.unit} each`, unit: context.unit,
            value: each, scope_count: null, per_scope_quantity: each, attribute: 'quantity', action: 'set' },
        ])], referents: [{ ref: goal.goal_id, source: 'persistent_state', confidence: .99 }] });
    } };
  }
  function correction(context, from, to) {
    const source = `${context.single} from ${from} ${context.unit} to ${to} ${context.unit}`;
    const text = `Correct ${context.subject}: ${source}`;
    return { text, reading: f => {
      const ref = entityReference(f, context);
      return wire({ intent: 'customer_correction', topic: context.subject, customer_correction: true,
        entities: [proposalEntity(context, ref, [{ scope: context.single, attribute: 'quantity', action: 'set',
          previous_value: from, value: to, unit: context.unit, source_text: source }])],
        referents: [{ ref, source: 'persistent_state', confidence: .99 }] });
    } };
  }
  function detail(context, key, value, answer) {
    const text = `For ${context.subject}, ${key.replaceAll('_', ' ')} is ${value}. Please compare the planning trade-offs using this detail.`;
    return { text, answer, expectAdvice: true, reading: wire({ intent: 'customer_guidance', topic: context.subject,
      customer_facts: [{ key, value }], demands: [demand(text, context.subject)] }) };
  }
  function merchant(model, fact = 'price', options = {}) {
    const text = options.text ?? `What is the current ${fact} of ${model}?`;
    return { text, kb: options.kb ?? rag(sourceDocument(model, options)),
      answer: options.answer ?? `The current published information for ${model} needs verification.`,
      reading: wire({ intent: 'merchant_facts', topic: model, requested_facts: [fact],
        demands: [demand(text, model, [fact], 'product')] }, 'ASK_FACT') };
  }
  function directItem(context, quantity = 1) {
    const text = `Add ${context.subject}: ${quantity} ${context.unit}. This is a requirement, not an order.`;
    return { text, answer: `Noted the requested ${quantity} ${context.unit} for ${context.subject}; no order has been placed.`,
      reading: wire({ intent: 'customer_requirements', topic: context.subject,
        entities: [proposalEntity(context, 'current:1', [], { quantity })],
        demands: [demand(text, context.subject)] }, 'ADD_ITEM') };
  }
  function lifecycle(context, operation, focus) {
    const text = `${operation === 'DEFER' ? 'Pause' : 'Cancel'} ${context.subject}.` + (focus ? ` Focus on ${focus.subject}.` : '');
    return { text, reading: f => {
      const ref = entityReference(f, context);
      return wire({ intent: 'lifecycle', topic: context.subject,
        referents: [{ ref, source: 'persistent_state', confidence: .99 }] }, operation);
    } };
  }
  function dimension(context, value, previous) {
    const text = previous === undefined ? `${context.subject} must be at most ${value}mm wide.`
      : `Correction: ${context.subject} width limit is ${value}mm, not ${previous}mm.`;
    return { text, answer: `The latest stated width limit for ${context.subject} is ${value}mm; compare published product dimensions before choosing.`,
      reading: f => {
        const ref = entityReference(f, context);
        return wire({ intent: 'customer_context_update', topic: context.subject,
          customer_correction: previous !== undefined,
          entities: [proposalEntity(context, ref, [], { attributes: { dimension_source_proofs: { max_width_mm: {
            axis:"width", bound:"maximum", status:"current_affirmative", clause:text, measurement:`${value}mm`,
            ...(previous === undefined ? {} : { prior_measurement:`${previous}mm` }) } } }, constraints: { max_width_mm: value } })],
          referents: [{ ref, source: 'persistent_state', confidence: .99 }],
          demands: [{ ...demand(text, context.subject), customer_correction: previous !== undefined }] });
      } };
  }
  function recap(language = 'en') {
    const text = language === 'zh-TW' ? '可唔可以用廣東話兩句總結我而家嘅要求？' : 'Please summarize everything in English.';
    return { text, reading: wire({ language, intent: 'customer_fact_recall', requested_facts: ['summary'],
      demands: [demand(text, null, ['summary'])] }, 'ASK_FACT') };
  }
  function historical() {
    const text = 'Using my hypothetical old price of HK$4,750 per session, three sessions plus HK$960 delivery, what is the total? This is not a current quote.';
    return { text, reading: wire({ intent: 'customer_only_calculation' }, 'ASK_CALCULATION') };
  }
  function handoff() {
    return { text: 'I want to talk to a human. Please ask the agent to review the latest corrected requirements in this same conversation.',
      reading: wire({ intent: 'request_human_now' }, 'NO_STATE_CHANGE'),
      expected: 'handoff', options: { handoffSetsHumanControl: true } };
  }
  function assertMerchant(entry, model, value) {
    const { f, source } = entry, reply = f.commits[0], calls = f.requests.filter(row => row.url.includes('context-search'));
    assert.equal(calls.length, 1); assert(calls[0].body.query.includes(model));
    assert.equal(reply.metadata.response_route, 'canonical_kb_direct_answer');
    assert.equal(reply.metadata.kb_request_contract.source_message_id, source);
    assert.equal(reply.metadata.citation_lineage.selected_document_id, 'journey-product-' + model);
    assert.deepEqual(reply.metadata.citation_lineage.evidence_chunk_ids, ['journey-product-' + model + '-full']);
    assert(reply.content.includes(model) && reply.content.includes(value), reply.content);
  }
  function assertRecap(entry, active, inactive) {
    const reply = entry.f.commits[0];
    assert.equal(reply.metadata.response_route, 'canonical_memory_recall', JSON.stringify(reply.metadata));
    assert(reply.content.includes(active.subject), reply.content);
    if (inactive) assert(reply.content.includes(inactive.subject) && /paused|deferred|暫緩|暂缓|cancelled|取消/iu.test(reply.content), reply.content);
    assert.deepEqual(entry.f.tables.conversation_commerce_state[0], entry.before, 'Read-only recap changed canonical Commerce');
    assert.equal(entry.f.requests.filter(row => row.url.includes('context-search')).length, 0);
  }
  function assertHandoff(entry) {
    assert.equal(entry.result.status, 200, JSON.stringify(entry.result));
    assert.equal(entry.result.body.escalation_rule, 'R1');
    assert.equal(entry.result.body.handoff_persisted, true);
    const calls = entry.f.requests.filter(row => row.url.endsWith('/rpc/explicit_handoff_tx'));
    assert.equal(calls.length, 1); assert.equal(calls[0].body.p_conversation_id, uuid(2));
    assert.equal(entry.f.tables.conversations[0].status, 'human_control');
    assert.equal(entry.f.commits.length, 0, 'AI persisted a reply after a human takeover');
    assert.equal(entry.f.requests.filter(row => row.url.includes('context-search')).length, 0);
    noTransaction(entry.f);
  }
  async function replay(entry) {
    const { f } = entry, before = JSON.stringify({ commerce: f.tables.conversation_commerce_state, memory: f.tables.conversation_memory_state });
    const models = modelRequests(f).length, kb = f.requests.filter(row => row.url.includes('context-search')).length;
    const response = await f.run(); assert.equal(response.body.idempotent, true, JSON.stringify(response));
    assert.equal(f.commits.length, 1); assert.equal(modelRequests(f).length, models);
    assert.equal(f.requests.filter(row => row.url.includes('context-search')).length, kb);
    assert.equal(JSON.stringify({ commerce: f.tables.conversation_commerce_state, memory: f.tables.conversation_memory_state }), before);
  }

  for (const context of BUSINESS_CONTEXTS) {
    register('A useful final guidance ' + context.id, ['A'], [context.id], async dialogue => {
      const entry = await dialogue.ask(scope(context));
      assert.equal(entry.f.commits[0].metadata.response_route, 'customer_guidance');
      assert.equal(entry.f.commits[0].content, context.answer);
      assert.equal(state(entry.f).entities.length, 0, 'Audience/location counts became invented products');
      assert.equal(generated(entry.f).length, 1);
      const prompt = JSON.stringify(generated(entry.f)[0].body);
      assert(prompt.includes(context.subject) && prompt.includes(context.group) && prompt.includes(context.single));
      assert.equal(entry.f.requests.filter(row => row.url.includes('context-search')).length, 0);
      memoryParity(entry.f); await replay(entry);
    });
    register('compound facts skip known questions ' + context.id, ['HOSTED-COMPOUND'], [context.id], async dialogue => {
      const entry = await dialogue.ask(scope(context, { detail: true }));
      assert.equal(entry.f.commits[0].content, context.answer);
      const canonical = state(entry.f).customer_constraints.contextual_scope_facts;
      assert.equal(canonical.length, 2); assert(canonical.every(fact => fact.source_message_id === entry.source));
      const m = entry.f.tables.conversation_memory_state[0].memory;
      assert.equal(m.current_customer_facts.find(fact => fact.key === context.detail)?.value, context.value);
      assert.equal(m.current_customer_facts.find(fact => fact.key === context.detail)?.source_message_id, entry.source);
      const prompt = JSON.stringify(generated(entry.f)[0].body);
      assert(prompt.includes(context.value), 'A supplied compound detail disappeared before generation');
      assert(!/how many|what is your|please confirm.*(?:count|quantity)/iu.test(entry.f.commits[0].content));
      assert.equal(state(entry.f).entities.length, 0); memoryParity(entry.f);
    });
  }

  register('W11 five persisted turns retain known details and allocate', ['W11-JOURNEY'], ['catering'], async dialogue => {
    const context = BUSINESS_CONTEXTS[0]; await dialogue.ask(scope(context));
    await dialogue.ask(detail(context, 'dietary_priority', context.value,
      'Use labelled vegetarian choices when comparing shared trays and individual portions; keep ingredient information available.'));
    await dialogue.ask(detail(context, 'serving_style', 'self service',
      'With self service and labelled vegetarian choices, compare separate serving tools and easy-to-read labels at the counter and tables.'));
    await dialogue.ask(detail(context, 'service_time', '12:30',
      'For self service at 12:30, coordinate tray arrival and ingredient labels before service. The two tables and counter remain the planned locations.'));
    const last = await dialogue.ask(allocation(context));
    assert.equal(item(last.f, context.subject).quantity, 3);
    assert.equal(last.f.commits[0].metadata.response_route, 'contextual_scoped_update');
    assert.match(last.f.commits[0].content, /Total 3 trays/u);
    for (const [key, value] of [['dietary_priority', context.value], ['serving_style', 'self service'], ['service_time', '12:30']]) {
      const fact = last.f.tables.conversation_memory_state[0].memory.current_customer_facts.find(row => row.key === key);
      assert.equal(fact?.value, value, 'Known detail lost across the five-turn handler sequence: ' + key);
    }
    assert.equal(dialogue.turns.length, 5); memoryParity(last.f); await replay(last);
  });

  register('W13 each of five accepted updates carries current B2 authority', ['W13-POSITIVE'], ['subscriptions'], async dialogue => {
    const context = BUSINESS_CONTEXTS[1]; await dialogue.ask(scope(context));
    await dialogue.ask(allocation(context));
    await dialogue.ask(correction(context, 1, 2));
    await dialogue.ask(correction(context, 2, 3));
    const last = await dialogue.ask(correction(context, 3, 1));
    assert.equal(dialogue.turns.length, 5); assert.equal(item(last.f, context.subject).quantity, 3);
    for (const [index, entry] of dialogue.turns.entries()) {
      const row = entry.f.tables.conversation_commerce_state[0], reply = entry.f.commits[0];
      assert.equal(row.source_message_id, entry.source); assert.equal(reply.metadata.b2_expected_revision, row.revision);
      assert.equal(row.revision, (entry.before?.revision ?? 0) + 1);
      if (index > 0) {
        assert.equal(reply.metadata.commerce_state_revision, row.revision);
        assert.equal(reply.metadata.response_route, 'contextual_scoped_update');
        assert(gates(entry.f).some(gate => gate.gate_code === 'B2_ALLOW_JOURNEY_PROGRESS_AFTER_ACCEPTED_UPDATE'), JSON.stringify(gates(entry.f)));
        assert(reply.metadata.contextual_decision.updates.every(update => update.source_message_id === entry.source && update.source_revision === row.revision));
      }
      memoryParity(entry.f);
    }
    await replay(last);
  });

  register('W15 eight persisted turns require fresh merchant evidence and isolate a new topic', ['W15'], ['rentals', 'subscriptions'], async dialogue => {
    const context = BUSINESS_CONTEXTS[2], second = BUSINESS_CONTEXTS[1], model = 'ER-QZ81';
    await dialogue.ask(scope(context));
    await dialogue.ask(detail(context, 'return_preference', context.value,
      'For one coordinated return, compare collection packaging and responsibility for checking each kit. Published return terms still need verification.'));
    await dialogue.ask(detail(context, 'event_priority', 'fast setup',
      'For fast setup, compare clear component labels and a rehearsal before the two booths and stage open.'));
    await dialogue.ask(detail(context, 'setup_window', '09:00',
      'At 09:00, use clear component labels to coordinate setup across the two booths and stage.'));
    await dialogue.ask(allocation(context));
    const price = await dialogue.ask(merchant(model, 'price', { price: 1280 })); assertMerchant(price, model, '1,280');
    const revised = await dialogue.ask(merchant(model, 'price', { price: 1460, text: `What is the current price of ${model} now?` }));
    assertMerchant(revised, model, '1,460'); assert(!revised.f.commits[0].content.includes('1,280'), 'Old merchant price was reused');
    const original = structuredClone(item(revised.f, context.subject));
    const last = await dialogue.ask(scope(second));
    assert.deepEqual(item(last.f, context.subject), original, 'A new service plan changed the retained rental');
    assert.equal(state(last.f).entities.length, 1, 'Research enquiry invented a subscription count');
    assert.equal(state(last.f).customer_constraints.contextual_goal.subject_label, second.subject);
    assert.equal(dialogue.turns.length, 8); memoryParity(last.f);
  });

  register('W11 materialized dimension correction after switch survives cancellation and continuation', ['W11-SWITCH'], ['rentals', 'subscriptions'], async dialogue => {
    const context = BUSINESS_CONTEXTS[2], secondary = BUSINESS_CONTEXTS[1];
    await dialogue.ask(scope(context)); await dialogue.ask(allocation(context));
    const firstLimit = await dialogue.ask(dimension(context, 600));
    assert.equal(item(firstLimit.f, context.subject).constraints.max_width_mm, 600);
    await dialogue.ask(scope(secondary)); await dialogue.ask(allocation(secondary));
    const retainedSecondary = structuredClone(item(dialogue.last, secondary.subject));
    const corrected = await dialogue.ask(dimension(context, 595, 600));
    assert.equal(item(corrected.f, context.subject).constraints.max_width_mm, 595);
    assert.deepEqual(item(corrected.f, secondary.subject), retainedSecondary);
    const cancelled = await dialogue.ask(lifecycle(secondary, 'CANCEL_ITEM', context));
    assert.equal(item(cancelled.f, secondary.subject).status, 'cancelled');
    assert.equal(item(cancelled.f, context.subject).constraints.max_width_mm, 595);
    const before = structuredClone(item(cancelled.f, secondary.subject));
    const continuation = `Back to ${context.subject}: would a width of 598mm fit?`;
    const continued = await dialogue.ask({ text: continuation,
      reading: f => wire({ intent: 'compare a product dimension against the current constraint', topic: context.subject,
        referents: [{ ref: entityReference(f, context), source: 'persistent_state', confidence: .99 }], requested_facts: ['width'],
        demands: [demand(continuation, context.subject, ['width'])] }, 'ASK_FACT') });
    assert.match(continued.f.commits[0].content, /598/); assert.match(continued.f.commits[0].content, /595/);
    assert.equal(continued.f.commits[0].metadata.transaction_mutation, 'NONE');
    assert.equal(continued.f.requests.filter(row => row.url.includes('context-search')).length, 0);
    assert.equal(continued.f.requests.filter(row => /\/rpc\/(?:upsert_conversation_commerce_state_v1|c3_commit_conversation_memory_tx)$/.test(row.url)).length, 0);
    assert.deepEqual(item(continued.f, secondary.subject), before, 'Continuing the retained subject reactivated the cancelled one');
    assert.deepEqual(continued.f.tables.conversation_commerce_state[0], continued.before);
    memoryParity(continued.f); await replay(continued);
  });

  register('natural dialogue ten consecutive persisted turns with bilingual recap and real R1 control', ['NATURAL-DIALOGUE'], ['catering', 'rentals'], async dialogue => {
    const context = BUSINESS_CONTEXTS[0], secondary = BUSINESS_CONTEXTS[2];
    await dialogue.ask(scope(context)); await dialogue.ask(allocation(context));
    const second = await dialogue.ask(directItem(secondary));
    assert.equal(item(second.f, secondary.subject).quantity, 1);
    await dialogue.ask(correction(context, 1, 2));
    const paused = await dialogue.ask(lifecycle(secondary, 'DEFER', context));
    assert.equal(item(paused.f, secondary.subject).status, 'deferred');
    const english = await dialogue.ask(recap('en')); assertRecap(english, context, secondary);
    assert(!/[\p{Script=Han}]/u.test(english.f.commits[0].content), 'English recap ignored the current language request');
    const cantonese = await dialogue.ask(recap('zh-TW')); assertRecap(cantonese, context, secondary);
    assert(/[\p{Script=Han}]/u.test(cantonese.f.commits[0].content), 'Cantonese recap did not use the requested language');
    const math = await dialogue.ask(historical()); assert.match(math.f.commits[0].content, /15,210/);
    assert.deepEqual(math.f.tables.conversation_commerce_state[0], math.before);
    const unknown = await dialogue.ask(merchant('MISSING-ZQ991', 'features', { kb: emptyKb() }));
    assert(unknown.f.commits[0].content.includes('MISSING-ZQ991'));
    assert(!unknown.f.commits[0].content.includes('detachable supports'));
    assert(!unknown.f.commits[0].metadata.kb_fact_proof);
    const human = await dialogue.ask(handoff()); assertHandoff(human);
    assert.equal(dialogue.turns.length, 10); assert.equal(item(human.f, context.subject).quantity, 4);
    assert.equal(item(human.f, secondary.subject).status, 'deferred');
  });

  register('W19 sixteen consecutive persisted turns preserve correction evidence and suppress AI after R1', ['W19'], ['rentals', 'subscriptions'], async dialogue => {
    const context = BUSINESS_CONTEXTS[2], secondary = BUSINESS_CONTEXTS[1], model = 'ER-KT64';
    await dialogue.ask(scope(context, { detail: true }));
    await dialogue.ask(allocation(context));
    await dialogue.ask(correction(context, 1, 2));
    const featureQuestion = `What are the current features and price of ${model}?`;
    const firstPrice = await dialogue.ask({ text: featureQuestion, kb: rag(sourceDocument(model, { price: 1280 })),
      answer: `The current product record lists ${model} at HK$1,280 and describes detachable supports and a padded transport case.`,
      verifierGrounded: true, verifierIds: ['E1'],
      options: { verifierDemandResolutions: [{ demand_id: 'demand-1', status: 'supported', evidence_ids: ['E1'] }] },
      reading: wire({ intent: 'merchant_facts', topic: model, requested_facts: ['features', 'price'],
        demands: [demand(featureQuestion, model, ['features', 'price'], 'product')] }, 'ASK_FACT') });
    const featureReply = firstPrice.f.commits[0];
    assert(featureReply.content.includes(model) && featureReply.content.includes('1,280') &&
      featureReply.content.includes('detachable supports'), featureReply.content);
    assert.equal(featureReply.metadata.grounding_verification.question_resolution, 'supported');
    assert.deepEqual(featureReply.metadata.citations.map(citation => citation.document_id), ['journey-product-' + model]);
    assert.equal(firstPrice.f.requests.filter(row => row.url.includes('context-search')).length, 1);
    const freshPrice = await dialogue.ask(merchant(model, 'price', { price: 1460 })); assertMerchant(freshPrice, model, '1,460');
    await dialogue.ask(scope(secondary)); await dialogue.ask(allocation(secondary));
    const paused = await dialogue.ask(lifecycle(secondary, 'DEFER', context));
    assert.equal(item(paused.f, secondary.subject).status, 'deferred');
    const english = await dialogue.ask(recap('en')); assertRecap(english, context, secondary);
    const cantonese = await dialogue.ask(recap('zh-TW')); assertRecap(cantonese, context, secondary);
    assert(/[\p{Script=Han}]/u.test(cantonese.f.commits[0].content));
    const calculationText = 'Using my hypothetical old price of HK$5,680 per session, two sessions plus HK$1,490 delivery, what is the total? This is not a current quote.';
    const math = await dialogue.ask({ text: calculationText, reading: wire({ intent: 'customer_only_calculation' }, 'ASK_CALCULATION') });
    assert.match(math.f.commits[0].content, /12,850/);
    assert.deepEqual(math.f.tables.conversation_commerce_state[0], math.before);
    const unknown = await dialogue.ask(merchant('UNKNOWN-QX771', 'features', { kb: emptyKb() }));
    assert(unknown.f.commits[0].content.includes('UNKNOWN-QX771') && !unknown.f.commits[0].metadata.kb_fact_proof);
    const problemText = `${model} is not working. What should I check?`;
    const problem = await dialogue.ask({ text: problemText,
      reading: wire({ intent: 'product_operation_failure', topic: model,
        demands: [demand(problemText,model)] }, 'ASK_FACT') });
    assert.match(problem.f.commits[0].content, /error|indicator|message|what.*(?:happens|see)|錯誤|燈號/iu);
    assert(!problem.f.commits[0].content.includes('detachable supports'), 'An operating failure became an unrelated feature answer');
    assert.equal(problem.f.requests.filter(row => row.url.includes('context-search')).length, 0);
    assert.deepEqual(problem.f.tables.conversation_commerce_state[0], problem.before);
    const priceQuestion = `What is the current price of ${model}?`;
    const suitabilityQuestion = `Can you confirm whether ${model} supports wireless control for my setup?`;
    const partialAnswer = `${model} is currently listed at HK$1,460. The supplied product record does not state whether it supports wireless control for your setup, so I cannot confirm that compatibility.`;
    const partial = await dialogue.ask({ text: `${priceQuestion} ${suitabilityQuestion}`,
      kb: rag(sourceDocument(model, { price: 1460 })), answer: partialAnswer, verifierGrounded: true, verifierIds: ['E1'],
      options: { verifierResolution: 'partial', verifierDemandResolutions: [
        { demand_id: 'demand-1', status: 'supported', evidence_ids: ['E1'] },
        { demand_id: 'demand-2', status: 'unavailable', evidence_ids: [] },
      ] }, reading: wire({ intent: 'merchant_facts', topic: model, requested_facts: ['price', 'wireless_control_support'],
        demands: [demand(priceQuestion, model, ['price'], 'product'),
          demand(suitabilityQuestion, model, ['wireless_control_support'], 'product')] }, 'ASK_FACT') });
    assert.equal(partial.f.commits[0].content, partialAnswer);
    assert.deepEqual(partial.f.commits[0].metadata.unresolved_fact_fields, ['demand-2']);
    assert.equal(partial.f.commits[0].metadata.grounding_verification.question_resolution, 'partial');
    assert.equal(partial.f.requests.filter(row => row.url.includes('context-search')).length, 1);
    assert.deepEqual(partial.f.tables.conversation_commerce_state[0], partial.before);
    assert.equal(item(partial.f, context.subject).quantity, 4); memoryParity(partial.f);
    const human = await dialogue.ask(handoff()); assertHandoff(human);
    const suppressed = await dialogue.ask({ text: 'The human agent should review my latest rental requirements; please keep the other request paused.',
      reading: wire({ intent: 'request_human_now' }, 'NO_STATE_CHANGE'), expected: 'suppressed' });
    assert.equal(suppressed.result.status, 200); assert.equal(suppressed.f.commits.length, 0);
    assert.equal(modelRequests(suppressed.f).length, 0); assert.equal(suppressed.f.requests.filter(row => row.url.includes('context-search')).length, 0);
    assert.deepEqual(suppressed.f.tables.conversation_commerce_state[0], suppressed.before);
    assert.equal(suppressed.f.tables.conversations[0].status, 'human_control');
    assert.equal(dialogue.turns.length, 16);
  });

  for (const language of ['en', 'zh-TW']) {
    register('language-prefixed complete recap is read-only ' + language, ['NATURAL-DIALOGUE', 'W19'], ['catering'], async dialogue => {
      const context = BUSINESS_CONTEXTS[0];
      await dialogue.ask(scope(context)); await dialogue.ask(allocation(context));
      const text = language === 'en' ? 'Please reply in English. Give me a recap of everything.' : '請用廣東話回覆：而家我有咩記低？';
      const entry = await dialogue.ask({ text, reading: wire({ language, intent: 'customer_fact_recall', requested_facts: ['summary'],
        demands: [demand(text, null, ['summary'])] }, 'ASK_FACT') });
      assertRecap(entry, context);
      assert.equal(/[\p{Script=Han}]/u.test(entry.f.commits[0].content), language === 'zh-TW');
      assert(entry.f.commits[0].content.includes('3'), entry.f.commits[0].content);
      memoryParity(entry.f);
    });
  }

  for (const mode of ['mixed price', 'mixed specification', 'mixed policy', 'missing Reading', 'forged source quote']) {
    register('operating failure negative ' + mode, ['W19'], ['rentals'], async dialogue => {
      const context=BUSINESS_CONTEXTS[2],model='ER-KT64';
      await dialogue.ask(scope(context));await dialogue.ask(allocation(context));
      const diagnostic=`${model} is not working. What should I check?`;
      const fact=mode==='mixed price'?'price':mode==='mixed specification'?'specification':'warranty policy';
      const merchantQuestion=`What is the current ${fact} of ${model}?`;
      const mixed=mode.startsWith('mixed '),text=mixed?`${diagnostic} ${merchantQuestion}`:diagnostic;
      const proposal=demand(diagnostic,model);
      if(mode==='forged source quote')proposal.source_quote='OTHER-KT99 is not working. What should I check?';
      const entry=await dialogue.ask({text,expected:'negative',kb:rag(sourceDocument(model,{price:1460})),
        ...(mode==='missing Reading'?{options:{mode:'malformed'}}:{}),
        reading:wire({intent:'product_operation_failure',topic:model,requested_facts:mixed?[fact]:[],
          demands:mixed?[proposal,demand(merchantQuestion,model,[fact],fact==='warranty policy'?'policy':'product')]:[proposal]},'ASK_FACT')});
      assert([200,409].includes(entry.result.status),JSON.stringify(entry.result));
      assert.deepEqual(entry.f.tables.conversation_commerce_state[0],entry.before);
      assert(!entry.f.commits.some(reply=>reply.metadata.service_action==='customer_issue_next_step' ||
        /Does it show any indicator light or error message/u.test(reply.content)),
        'An unproved or mixed request skipped merchant/source validation');
      if(mixed)assert.equal(entry.f.requests.filter(row=>row.url.includes('context-search')).length,1);
      else assert.equal(entry.f.requests.filter(row=>row.url.includes('context-search')).length,0);
      noTransaction(entry.f);
    });
  }

  for (const mode of ['mixed merchant price', 'merchant specification without measurement', 'forged comparison quote']) {
    register('dimension read negative ' + mode, ['W11-SWITCH'], ['rentals'], async dialogue => {
      const context = BUSINESS_CONTEXTS[2], model = 'ER-KT64';
      await dialogue.ask(scope(context)); await dialogue.ask(allocation(context)); await dialogue.ask(dimension(context, 595));
      const comparison = `Would ${context.subject} width 598mm fit?`;
      const price = `What is the current price of ${model}?`;
      const specification = `What is the current width of ${model}?`;
      const text = mode === 'mixed merchant price' ? `${comparison} ${price}`
        : mode === 'merchant specification without measurement' ? specification : comparison;
      const entry = await dialogue.ask({ text, expected: 'negative', kb: rag(sourceDocument(model, { price: 1460 })),
        reading: f => wire({ intent: 'fact_query', topic: context.subject,
          referents: [{ ref: entityReference(f, context), source: 'persistent_state', confidence: .99 }],
          requested_facts: mode === 'mixed merchant price' ? ['width', 'price'] : ['width'],
          demands: mode === 'mixed merchant price'
            ? [demand(comparison, context.subject, ['width']), demand(price, model, ['price'], 'product')]
            : mode === 'merchant specification without measurement'
            ? [demand(specification, model, ['width'], 'product')]
            : [{ ...demand(comparison, context.subject, ['width']), source_quote: `Would ${context.subject} width 200mm fit?` }],
        }, 'ASK_FACT') });
      assert([200, 409].includes(entry.result.status), JSON.stringify(entry.result));
      assert.deepEqual(entry.f.tables.conversation_commerce_state[0], entry.before);
      assert(entry.f.commits.every(reply => reply.metadata.commerce_reason !== 'read_only_attribute_constraint_query_resolved'));
      if (mode !== 'forged comparison quote') assert.equal(entry.f.requests.filter(row => row.url.includes('context-search')).length, 1);
      assert(!entry.f.commits.some(reply => /598 mm (?:exceeds|is within)/u.test(reply.content)), 'A mixed or forged reading bypassed the factual pipeline');
      noTransaction(entry.f);
    });
  }

  for (const mode of ['forged-count', 'duplicate-scope']) register('compound scope negative ' + mode,
    ['HOSTED-COMPOUND'], ['catering'], async dialogue => {
      const context = BUSINESS_CONTEXTS[0], input = scope(context, { detail: true });
      const source = input.text, facts = [{ key: context.detail, value: context.value },
        { key: 'contextual_scope_counts', value: [
          { scope: context.group, count: mode === 'forged-count' ? 9 : 2, source_text: '2 ' + context.group, subject_label: context.subject },
          { scope: context.single, count: 1, source_text: '1 ' + context.single, subject_label: context.subject },
        ] }];
      if (mode === 'duplicate-scope') facts.push(structuredClone(facts[1]));
      const entry = await dialogue.ask({ ...input, expected: 'negative',
        reading: wire({ topic: context.subject, customer_facts: facts, demands: [demand(source, context.subject)] }) });
      assert.equal(entry.result.status, 200);
      assert(!state(entry.f)?.customer_constraints.contextual_goal && !state(entry.f)?.entities.length,
        'A forged compound scope obtained canonical business authority');
      const m = entry.f.tables.conversation_memory_state[0]?.memory;
      assert(m && !m.active_entities.length);
      const independent = m.current_customer_facts.find(fact => fact.key === context.detail);
      assert.equal(independent?.value, context.value); assert.equal(independent?.source_message_id, entry.source);
    });

  for (const bad of [false, true]) register('Simplified Chinese literal unit allocation ' + (bad ? 'missing Reading refuses' : 'commits source unit'),
    ['W9-2-LANGUAGE'], ['subscriptions'], async dialogue => {
      const context = { subject: '软件订阅', unit: '席位' };
      const firstText = '软件订阅给两个部门和一个前台，请先比较安排的一般取舍。';
      await dialogue.ask({ text: firstText, answer: '两个部门和一个前台可以比较独立访问与集中管理。先按权限需求安排；具体计划条款需要再核实。',
        reading: wire({ language: 'zh-CN', topic: context.subject, customer_facts: [{ key: 'contextual_scope_counts', value: [
          { scope: '部门', count: 2, source_text: '两个部门', subject_label: context.subject },
          { scope: '前台', count: 1, source_text: '一个前台', subject_label: context.subject },
        ] }], demands: [demand(firstText, context.subject)] }) });
      const before = structuredClone(dialogue.last.tables.conversation_commerce_state[0]);
      const entry = await dialogue.ask({ text: '前台1席位，部门各1席位', expected: bad ? 'negative' : undefined,
        ...(bad ? { options: { mode: 'malformed' } } : {}),
        reading: f => {
          if (bad) return wire({ language: 'zh-CN', intent: 'other' }, 'NO_STATE_CHANGE');
          const ref = outbound(f).state.customer_constraints.contextual_goal.goal_id;
          return wire({ language: 'zh-CN', intent: 'scoped allocation', topic: context.subject,
            entities: [proposalEntity(context, ref, [
              { scope: '前台', source_text: '前台1席位', unit: '席位', value: 1, attribute: 'quantity', action: 'set' },
              { scope: '部门', source_text: '部门各1席位', unit: '席位', value: 1, per_scope_quantity: 1, scope_count: null, attribute: 'quantity', action: 'set' },
            ])], referents: [{ ref, source: 'persistent_state', confidence: .99 }] });
        } });
      if (bad) assert.deepEqual(entry.f.tables.conversation_commerce_state[0], before, 'Absent allocation Reading changed the count');
      else {
        assert.equal(item(entry.f, context.subject).quantity, 3);
        assert.match(entry.f.commits[0].content, /已记录/u); assert.match(entry.f.commits[0].content, /3席位/u);
        assert.match(entry.f.commits[0].content, /尚未下单/u); assert(!entry.f.commits[0].content.includes('部。'));
      }
    });

  for (const context of BUSINESS_CONTEXTS) register('unproved transaction draft is blocked ' + context.id,
    ['A', 'W11-JOURNEY', 'HOSTED-COMPOUND'], [context.id], async dialogue => {
      const input = scope(context); input.answer = `Your order for ${context.subject} is confirmed and payment received.`;
      const entry = await dialogue.ask({ ...input, expected: 'negative' });
      noTransaction(entry.f);
      assert(!entry.f.commits.some(reply => /order.*confirmed|payment received/iu.test(reply.content)),
        'A provider draft created a transaction acknowledgement');
      assert(gates(entry.f).some(gate => gate.gate_decision !== 'allow'), 'The false transaction never reached the safety gate');
    });
  for (const mode of ['correct reference', 'wrong known reference', 'missing reference']) {
    register('W19 earlier model after competing topic ' + mode, ['W19'], ['rentals', 'subscriptions', 'catering'], async dialogue => {
      const primary=BUSINESS_CONTEXTS[2],secondary=BUSINESS_CONTEXTS[1];
      const oldModel='ER-OLD71',competingModel='CT-NEW82';
      await dialogue.ask(scope(primary));await dialogue.ask(allocation(primary));
      const original=await dialogue.ask(merchant(oldModel,'price',{price:1280}));
      assertMerchant(original,oldModel,'1,280');
      await dialogue.ask(scope(secondary));await dialogue.ask(allocation(secondary));
      const deferred=await dialogue.ask(lifecycle(secondary,'DEFER',primary));
      assert.equal(item(deferred.f,secondary.subject).status,'deferred');
      const competing=await dialogue.ask(merchant(competingModel,'price',{price:9990}));
      assertMerchant(competing,competingModel,'9,990');
      const text='Return to the first model, price?';
      const reference=mode==='correct reference'?oldModel:mode==='wrong known reference'?competingModel:null;
      const entry=await dialogue.ask({text,expected:mode==='correct reference'?undefined:'negative',
        kb:rag(sourceDocument(oldModel,{price:1640}),sourceDocument(competingModel,{price:9990})),
        answer:`The earlier model is ${oldModel}. Its current product record lists HK$1,640.`,
        verifierGrounded:true,verifierIds:['E1'],
        options:{verifierDemandResolutions:[{demand_id:'demand-1',status:'supported',evidence_ids:['E1']}]},
        reading:wire({intent:'merchant_facts',topic:reference,requested_facts:['price'],
          referents:reference?[{ref:reference,source:'prior_turn',confidence:.99}]:[],
          demands:[{...demand(text,reference,['price'],'product'),
            question:reference?`What is the current price of ${reference}?`:text}]},'ASK_FACT')});
      assert.equal(entry.result.status,200,JSON.stringify(entry.result));
      assert.deepEqual(entry.f.tables.conversation_commerce_state[0],entry.before,
        'A merchant referent query mutated canonical requirements/lifecycle');
      assert.equal(item(entry.f,primary.subject).quantity,3);
      assert.equal(item(entry.f,secondary.subject).status,'deferred');
      const calls=entry.f.requests.filter(row=>row.url.includes('context-search'));
      for(const call of calls){
        const request=JSON.parse(call.body.query);
        assert(request.questions?.length===1 && request.questions[0].subjects?.length===1 &&
          request.questions[0].subjects[0]===oldModel,
          'Earlier-model source selected a wrong or unscoped merchant target: '+JSON.stringify(request));
        assert(!call.body.query.includes(competingModel),'Competing model contaminated current retrieval');
      }
      assert(!entry.f.commits.some(reply=>reply.content.includes(competingModel)||reply.content.includes('9,990')),
        'The competing product became the answer to an earlier-model request');
      if(mode==='correct reference'){
        const reply=entry.f.commits[0];
        assert.equal(calls.length,1);assert(reply.content.includes(oldModel) && reply.content.includes('1,640'));
        const documentIds=reply.metadata.citations?.map(citation=>citation.document_id) ?? [reply.metadata.citation_lineage?.selected_document_id];
        assert(documentIds.includes('journey-product-'+oldModel),'Earlier model answer lost its current document lineage');
        const contract=reply.metadata.kb_request_contract;
        assert.equal(contract.subject_source_message_id,original.source);
        assert(!entry.f.commits[0].content.includes('1,280'),'Old merchant amount replaced the fresh query');
        memoryParity(entry.f);await replay(entry);
      }else{
        assert(calls.length===0 || entry.f.commits.some(reply=>reply.metadata.kb_request_contract?.subject_source_message_id===original.source),
          'A repaired reference lacked the original Visitor-source lineage');
        assert(entry.f.commits.every(reply=>!reply.metadata.kb_fact_proof || calls.length===1),
          'No lookup could manufacture a current merchant proof');
      }
      noTransaction(entry.f);assert.equal(dialogue.turns.length,8);
    });
  }
  for(const mode of ['wrongvalue','wrongtarget','no-number','wrongaxis']){
    register('dimension writer rejection asks exact clarification '+mode,['W11-SWITCH'],['rentals','subscriptions'],async dialogue=>{
      const primary=BUSINESS_CONTEXTS[2],secondary=BUSINESS_CONTEXTS[1];
      await dialogue.ask(scope(primary));await dialogue.ask(allocation(primary));await dialogue.ask(dimension(primary,595));
      await dialogue.ask(scope(secondary));await dialogue.ask(allocation(secondary));
      const priorMemory=structuredClone(dialogue.last.tables.conversation_memory_state);
      const text=mode==='no-number'?`${primary.subject} width limit should be smaller.`:
        `${primary.subject} must be at most 590mm ${mode==='wrongaxis'?'high':'wide'}.`;
      const entry=await dialogue.ask({text,reading:f=>{
        const target=mode==='wrongtarget'?secondary:primary,ref=entityReference(f,target);
        return wire({intent:'customer_context_update',topic:target.subject,
          entities:[proposalEntity(target,ref,[],{attributes:{dimension_source_proofs:{max_width_mm:{axis:mode==='wrongaxis'?'height':'width',bound:'maximum',status:'current_affirmative',clause:text,measurement:mode==='no-number'?'':'590mm'}}},constraints:{max_width_mm:mode==='wrongvalue'?600:590}})],
          referents:[{ref,source:'persistent_state',confidence:.99}],demands:[demand(text,primary.subject)]});
      }});
      const reply=entry.f.commits[0];
      assert.equal(reply.metadata.commerce_reason,'contextual_targeted_clarification');
      assert.equal(reply.metadata.contextual_decision.reason,'UNVERIFIED_CUSTOMER_REQUIREMENT');
      assert.equal(reply.metadata.commerce_state_persist_result,'read_only');
      assert.equal(reply.metadata.transaction_mutation,'NONE');
      assert.match(reply.content,/which item|exact measurement|quantity.*unit/iu);
      assert(!/590|600/u.test(reply.content),'Unproved proposed value appeared as an acknowledgement');
      assert(gates(entry.f).some(gate=>gate.gate_code==='B2_ALLOW_TARGETED_READ_ONLY_CLARIFICATION'));
      assert.deepEqual(entry.f.tables.conversation_commerce_state[0],entry.before);
      assert.deepEqual(entry.f.tables.conversation_memory_state,priorMemory);
      assert.equal(entry.f.requests.filter(row=>/\/rpc\/(?:upsert_conversation_commerce_state_v1|c3_commit_conversation_memory_tx)$/.test(row.url)).length,0);
      assert.equal(entry.f.requests.filter(row=>row.url.includes('context-search')).length,0);
      noTransaction(entry.f);await replay(entry);
    });
  }
  // P1-LEGACY-01: a valid source-owned requirement and a separate merchant
  // question must both survive the same real handler/decoder/CAS/B2 call.
  // A question-only proposal must still never become a dimension write.
  register('natural dialogue valid dimension and independent merchant answer both persist', ['NATURAL-DIALOGUE'], ['rentals'], async dialogue => {
    const retained=BUSINESS_CONTEXTS[2], model='ER-LM84', context={subject:model,unit:'kits'};
    const first=await dialogue.ask(directItem(retained));
    const original=structuredClone(item(first.f,retained.subject));
    const statement='I need ER-LM84 to be at most 600mm wide.';
    const question='What is the current price of ER-LM84?';
    const text=statement+' '+question;
    const dimensionEntity=(ref,clause,value)=>proposalEntity(context,ref,[],{
      kind:'physical_product',model,unit:null,quantity:null,
      attributes:{dimension_source_proofs:{max_width_mm:{axis:'width',bound:'maximum',status:'current_affirmative',clause,measurement:value+'mm'}}},
      constraints:{max_width_mm:value}
    });
    const mixed=await dialogue.ask({text,kb:rag(sourceDocument(model,{price:1460})),
      reading:wire({intent:'customer_requirements',topic:model,requested_facts:['price'],
        entities:[dimensionEntity('current:1',statement,600)],demands:[demand(question,model,['price'],'product')]},'ADD_ITEM')});
    const stored=item(mixed.f,model), reply=mixed.f.commits[0];
    assert.equal(stored.constraints.max_width_mm,600,'Valid dimension was lost before the merchant answer');
    assert.equal(stored.provenance.source_message_id,mixed.source);
    assert.equal(stored.quantity,0,'Research requirement invented a requested quantity');
    assert.equal(state(mixed.f).entities.length,2);
    assert.deepEqual(item(mixed.f,retained.subject),original);
    assert.equal(mixed.f.tables.conversation_commerce_state[0].revision,mixed.before.revision+1);
    assertMerchant(mixed,model,'1,460');
    assert.equal(reply.metadata.transaction_mutation,'NONE');
    memoryParity(mixed.f);
    const commerceRow=mixed.f.tables.conversation_commerce_state[0];
    const memoryRow=mixed.f.tables.conversation_memory_state[0];
    const projected=memoryRow.memory.active_entities.filter(entity=>entity.entity_id===stored.entity_id);
    assert.equal(projected.length,1,'Canonical Memory lost or duplicated the committed dimension item');
    assert.equal(projected[0].current_requirements.max_width_mm,600);
    assert.deepEqual(projected[0].current_requirements,{...stored.attributes,...stored.constraints});
    assert.equal(memoryRow.source_message_id,mixed.source);
    assert.equal(memoryRow.memory.source_message_id,mixed.source);
    assert.equal(memoryRow.commerce_state_revision,commerceRow.revision);
    assert.equal(memoryRow.memory.commerce_state_revision,commerceRow.revision);
    await replay(mixed);
    const questionOnly='Should ER-LM84 be at most 590mm wide?';
    const rejected=await dialogue.ask({text:questionOnly,reading:f=>wire({
      intent:'customer_context_update',topic:model,
      entities:[dimensionEntity(entityReference(f,context),questionOnly.slice(0,-1),590)],
      referents:[{ref:entityReference(f,context),source:'persistent_state',confidence:.99}],
      demands:[demand(questionOnly,model)]
    },'UPDATE_ITEM')});
    assert.deepEqual(rejected.f.tables.conversation_commerce_state[0],rejected.before,
      'A question fragment acquired dimension mutation authority');
    assert.equal(item(rejected.f,model).constraints.max_width_mm,600);
    assert.equal(rejected.f.requests.filter(row=>/\/rpc\/upsert_conversation_commerce_state_v1$/.test(row.url)).length,0);
    noTransaction(rejected.f);
  });

  // S2 equivalence: use the immutable original three-turn business fixtures
  // with their original synthetic KB responses. Natural variants change only
  // the read-only customer clause; the current merchant-price clause is unchanged.
  // These are separate Handler assertions, not replacement observation oracles.
  const s2Rows = [
    ['retail','書枱','張',3,'我之前提過幾張書枱？','另外目前每張官方售價是多少？','麻煩重述一下我為書枱所記錄的要求？','700'],
    ['restaurant','套餐','份',3,'我之前提過幾份套餐？','今天每份官方售價是多少？','麻煩重述一下我為套餐所記錄的要求？','180'],
    ['education','英語課','課',3,'我之前提過幾課英語課？','現在每課學費是多少？','麻煩重述一下我為英語課所記錄的要求？','200'],
    ['beauty','美容療程','堂',3,'我之前提過幾堂療程？','現在每堂售價是多少？','麻煩重述一下我為美容療程所記錄的要求？','500'],
    ['saas','licenses','licenses',3,'How many licenses did I mention earlier','what is their current official price?','Could you recap my recorded licenses entry?','12'],
    ['b2b-wholesale','paper cups','cartons',120,'How many cartons did I mention','what is the current official wholesale price?','Could you recap my recorded paper cups entry?','4.20'],
  ];
  const s2Norm = text => String(text ?? '').normalize('NFKC').replace(/\s+/gu,' ').trim();
  async function s2Seed(dialogue, spec) {
    const [domain,subject,unit,count]=spec;
    const fs=await import('node:fs');
    const {loadObservationCases,buildTurnInput}=await import('./p1-observation-fixtures.mjs');
    const id='SYNTHETIC-'+domain+'-mixed-known-unknown';
    const matches=loadObservationCases(fs,root).rows.filter(row=>row.id===id);
    assert.equal(matches.length,1,'Original observation case must be retained: '+id);
    const row=matches[0]; assert.equal(row.turns.length,3);
    assert.equal(row.must.answer_known_customer_count,true);
    assert.equal(row.must.requery_merchant_price,true);
    assert.equal(row.must.historical_price_is_not_current,true);
    assert.equal(row.must.no_current_price_without_evidence,true);
    const inputs=row.turns.map((text,i)=>({text,...buildTurnInput(row,i,'scripted',fs,root)}));
    const first=await dialogue.ask({text:inputs[0].text,options:inputs[0].options});
    const e=item(first.f,subject);
    assert.equal(e.quantity,count); assert.equal(e.attributes.unit,unit);
    assert.equal(e.provenance.source_message_id,first.source);
    memoryParity(first.f);
    // The original B2B fixture explicitly records USD 4.20 as historical
    // customer speech. Preserve that fact, never grant current quote authority.
    const historical=domain==='b2b-wholesale'?{amount:4.2,currency:'USD'}:undefined;
    const second=await dialogue.ask({text:inputs[1].text,options:inputs[1].options,expectedHistoricalQuote:historical});
    assert.equal(item(second.f,subject).quantity,count);
    assert.equal(item(second.f,subject).attributes.unit,unit);
    assert.equal(item(second.f,subject).provenance.source_message_id,first.source);
    memoryParity(second.f);
    return {row,inputs,first,second,expectedHistoricalQuote:historical?{...historical,source_message_id:second.source}:undefined};
  }
  function s2MixedReading(spec,recall,merchant,subjectOverride) {
    const [domain,subject]=spec, ref=subjectOverride??subject;
    return wire({language:domain==='saas'||domain==='b2b-wholesale'?'en':'zh-TW',
      intent:'mixed_customer_and_merchant_facts',requested_facts:['quantity','price'],
      referents:[{ref,source:'prior_turn',confidence:.98}],
      demands:[demand(recall,ref,['quantity'],'general'),demand(merchant,ref,['price'],'product')]},'ASK_FACT');
  }
  function s2AssertMixed(entry,seed,spec,recall,merchant) {
    const [,subject,unit,count,,,,historical]=spec;
    const f=entry.f,reply=f.commits[0],meta=reply.metadata;
    const calls=f.requests.filter(row=>row.url.includes('context-search'));
    assert.equal(calls.length,1,'Independent current price must be queried once');
    const query=s2Norm(calls[0].body.query);
    assert(query.includes(s2Norm(subject)),query);
    assert(query.includes(s2Norm(merchant)),query);
    assert(!query.includes(s2Norm(recall)),'Customer recall leaked into merchant query: '+query);
    assert(!query.includes(historical),'Historical unverified amount leaked into merchant query: '+query);
    assert.equal(meta.response_route,'mixed_customer_guidance');
    assert.equal(meta.service_action,'partial_answer');
    assert.equal(meta.grounding_state,'no_current_evidence');
    assert.equal(meta.historical_evidence_promoted,false);
    assert.equal(meta.merchant_evidence_unavailable,true);
    assert.equal(meta.handoff_required,false);
    const receipt=meta.mixed_customer_fact_resolution;
    assert.equal(receipt?.contract,'source-bound-mixed-quantity-v1');
    assert.equal(receipt.source_message_id,entry.source);
    assert.equal(receipt.commerce_state_revision,entry.before.revision);
    assert.equal(receipt.fact_type,'quantity');
    assert.equal(meta.recall_fact_type,'quantity');
    assert.equal(meta.recall_provenance?.length,1);
    const proof=meta.recall_provenance[0];
    assert.equal(proof.source_message_id,seed.first.source);
    assert.equal(proof.quantity_unit_source_message_id,seed.first.source);
    assert.equal(proof.quantity_unit_source_kind,'canonical_customer_attribute');
    assert.equal(proof.entity_id,item(f,subject).entity_id);
    assert.equal(proof.state_path,'entities.'+state(f).entities.findIndex(e=>e.entity_id===proof.entity_id)+'.quantity');
    assert(s2Norm(reply.content).includes(subject),reply.content);
    assert(s2Norm(reply.content).includes(String(count))||count===3&&s2Norm(reply.content).includes('三'),reply.content);
    assert(s2Norm(reply.content).includes(unit),reply.content);
    assert(!s2Norm(reply.content).includes(historical),'Unverified historical figure in partial reply: '+reply.content);
    assert.deepEqual(f.tables.conversation_commerce_state[0],entry.before,'Read-only mixed demand mutated Commerce');
    memoryParity(f); noTransaction(f,seed.expectedHistoricalQuote);
  }
  for(const spec of s2Rows)for(const style of ['original','natural']){
    const [domain,subject,,,originalRecall,merchant,naturalRecall]=spec;
    register('S2 full Handler mixed quantity and price '+domain+' '+style,
      ['SYNTHETIC-'+domain+'-mixed-known-unknown'],[domain],async dialogue=>{
      const seed=await s2Seed(dialogue,spec),last=seed.inputs[2];
      const recall=style==='original'?originalRecall:naturalRecall;
      assert(seed.row.turns[2].includes(originalRecall)&&seed.row.turns[2].includes(merchant));
      const text=style==='original'?last.text:recall+' '+merchant;
      const entry=style==='original'
        ?await dialogue.ask({text,options:last.options,expectedHistoricalQuote:seed.expectedHistoricalQuote})
        :await dialogue.ask({text,kb:last.options.originalRagResponse,
          reading:s2MixedReading(spec,recall,merchant),answer:'',verifierGrounded:false,expectedHistoricalQuote:seed.expectedHistoricalQuote});
      s2AssertMixed(entry,seed,spec,recall,merchant);
      await replay(entry);
    });
  }
  for(const mode of ['foreign referent','missing Reading','unrepresented cancellation']){
    const spec=s2Rows[5], [domain,subject,,,originalRecall,merchant,naturalRecall]=spec;
    register('S2 full Handler mixed negative '+mode,['SYNTHETIC-'+domain+'-mixed-known-unknown'],[domain],
      async dialogue=>{
      const seed=await s2Seed(dialogue,spec);
      const text=naturalRecall+' '+merchant+(mode==='unrepresented cancellation'?' Please cancel my order.':'');
      const entry=await dialogue.ask({text,expected:'negative',kb:seed.inputs[2].options.originalRagResponse,
        reading:s2MixedReading(spec,naturalRecall,merchant,mode==='foreign referent'?'unrelated-subject':undefined),
        answer:'',verifierGrounded:false,...(mode==='missing Reading'?{options:{semanticRaw:''}}:{})});
      assert(entry.f.commits.every(reply=>!reply.metadata.mixed_customer_fact_resolution),
        'An unproved mixed demand received attested customer-fact resolution');
      assert(entry.f.commits.every(reply=>reply.metadata.historical_evidence_promoted!==true));
      assert.deepEqual(entry.f.tables.conversation_commerce_state[0],entry.before,
        'Invalid Reading or unrepresented action changed Commerce');
      noTransaction(entry.f,seed.expectedHistoricalQuote);
    });
  }

  return labels;
}
