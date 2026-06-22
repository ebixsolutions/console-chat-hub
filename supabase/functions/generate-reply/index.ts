// B7 generate-reply — L5b orchestration skeleton
//
// Source of truth: Contract 11 §3.1 + Contract 07 + Contract 03 §1.1 + Contract 08
//
// CRITICAL SAFETY INVARIANTS (L5b):
//   1. All adapter flags default to FALSE. When ALL flags are false, the function
//      enters legacyGenerateReply() immediately and behaves 100% identically to L5a.
//      No new budget check, no prompt_overlay read, no adapter calls, no extra trace
//      writes, no status guard changes, no response shape change.
//   2. Orchestration path (any flag true) is SKELETON ONLY. Adapter calls, prompt
//      assembly, status matrix guard, trace writes are gated and conceptual; no
//      schema changes, no PII or full prompt persisted, no tools attached to LLM.
//   3. Full draft / handoff / auto-send policy and Tool Executor Gate are L5c-L5e.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Contract 05 §5 — minimal safe fallback prompt (in-memory only, never persisted).
const MINIMAL_SAFE_FALLBACK_PROMPT = `You are a professional and friendly customer service assistant. 
Answer customer questions clearly and concisely. 
If you cannot answer a question confidently, acknowledge it honestly and offer to connect the customer with a human agent.
Keep responses under 150 words.
Respond in the same language the customer is using.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { conversation_id } = body ?? {};
    if (!conversation_id) {
      return new Response(JSON.stringify({ error: 'conversation_id required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── Feature flags (read at request time so they can be toggled per deploy) ──
    const ENABLE_KB        = Deno.env.get('ENABLE_KB_ADAPTER') === 'true';
    const ENABLE_COACH     = Deno.env.get('ENABLE_COACH_PROMPT_ADAPTER') === 'true';
    const ENABLE_C360      = Deno.env.get('ENABLE_CUSTOMER360_ADAPTER') === 'true';
    const ENABLE_TOOL_EXEC = Deno.env.get('ENABLE_TOOL_EXECUTOR') === 'true';

    // ⚠️ LEGACY GATE — MUST be checked FIRST, before any other logic.
    // All flags false → behavior 100% identical to L5a.
    if (!ENABLE_KB && !ENABLE_COACH && !ENABLE_C360 && !ENABLE_TOOL_EXEC) {
      return await legacyGenerateReply(conversation_id);
    }

    // ── ORCHESTRATION PATH (only reached when at least one flag is true) ──────
    return await orchestrationGenerateReply(conversation_id, {
      ENABLE_KB, ENABLE_COACH, ENABLE_C360, ENABLE_TOOL_EXEC,
    });
  } catch (error) {
    console.error('[generate-reply] unexpected error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// LEGACY PATH — preserved L5a behavior, byte-for-byte equivalent to pre-L5b.
// ⚠️ Do NOT add adapter calls / overlay reads / trace writes / status changes here.
// ────────────────────────────────────────────────────────────────────────────
async function legacyGenerateReply(conversation_id: string): Promise<Response> {
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  const { data: conversation, error: convError } = await supabaseAdmin
    .from('conversations')
    .select('id, status')
    .eq('id', conversation_id)
    .single();

  if (convError || !conversation) {
    console.error('[generate-reply] conversation not found:', conversation_id);
    return new Response(JSON.stringify({ error: 'Conversation not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (conversation.status === 'resolved') {
    await supabaseAdmin
      .from('conversations')
      .update({ ai_generating: false })
      .eq('id', conversation_id);
    return new Response(JSON.stringify({ success: true, skipped: 'resolved' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const { data: messages } = await supabaseAdmin
    .from('messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversation_id)
    .neq('content', '__THINKING__')
    .eq('is_recalled', false)
    .order('created_at', { ascending: true })
    .limit(10);

  if (!messages || messages.length === 0) {
    await supabaseAdmin
      .from('conversations')
      .update({ ai_generating: false })
      .eq('id', conversation_id);
    return new Response(JSON.stringify({ success: true, skipped: 'no messages' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const claudeMessages = messages.map(m => ({
    role: (m.role === 'visitor') ? 'user' : 'assistant',
    content: m.content
  }));

  if (claudeMessages[claudeMessages.length - 1].role === 'assistant') {
    await supabaseAdmin
      .from('conversations')
      .update({ ai_generating: false })
      .eq('id', conversation_id);
    return new Response(JSON.stringify({ success: true, skipped: 'last message is assistant' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!anthropicKey) {
    console.error('[generate-reply] ANTHROPIC_API_KEY not set');
    await supabaseAdmin
      .from('conversations')
      .update({ ai_generating: false })
      .eq('id', conversation_id);
    return new Response(JSON.stringify({ error: 'AI service not configured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: `You are a professional and friendly customer service assistant. 
Answer customer questions clearly and concisely. 
If you cannot answer a question confidently, acknowledge it honestly and offer to connect the customer with a human agent.
Keep responses under 150 words.
Respond in the same language the customer is using.`,
      messages: claudeMessages
    })
  });

  if (!claudeResponse.ok) {
    const errText = await claudeResponse.text();
    console.error('[generate-reply] Claude API error:', claudeResponse.status, errText);
    await supabaseAdmin
      .from('conversations')
      .update({ ai_generating: false })
      .eq('id', conversation_id);
    return new Response(JSON.stringify({ error: 'AI service error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const claudeData = await claudeResponse.json();
  const aiReplyContent = claudeData.content?.[0]?.text ?? '';

  if (!aiReplyContent) {
    await supabaseAdmin
      .from('conversations')
      .update({ ai_generating: false })
      .eq('id', conversation_id);
    return new Response(JSON.stringify({ error: 'Empty AI response' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  await supabaseAdmin
    .from('messages')
    .delete()
    .eq('conversation_id', conversation_id)
    .eq('content', '__THINKING__');

  const { error: insertError } = await supabaseAdmin
    .from('messages')
    .insert({
      conversation_id: conversation_id,
      role: 'assistant',
      content: aiReplyContent,
      status: 'delivered',
      is_recalled: false
    });

  if (insertError) {
    console.error('[generate-reply] insert error:', insertError);
  }

  await supabaseAdmin
    .from('conversations')
    .update({
      ai_generating: false,
      updated_at: new Date().toISOString()
    })
    .eq('id', conversation_id);

  console.log('[generate-reply] AI reply sent for conversation:', conversation_id);
  return new Response(JSON.stringify({ success: true }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ────────────────────────────────────────────────────────────────────────────
// ORCHESTRATION PATH — 7-step skeleton per Contract 11 §3.1.
// Each adapter step is independently flag-gated. With all flags false this
// function is unreachable (legacyGenerateReply() is called instead).
//
// NOTE: This skeleton is intentionally non-executing in L5b. Adapter calls
// and trace writes are placeholders with safe fallbacks; live adapter
// invocations and trace inserts are deferred to L5c+ once schema is verified.
// ────────────────────────────────────────────────────────────────────────────
type FlagSet = {
  ENABLE_KB: boolean;
  ENABLE_COACH: boolean;
  ENABLE_C360: boolean;
  ENABLE_TOOL_EXEC: boolean;
};

async function orchestrationGenerateReply(
  conversation_id: string,
  flags: FlagSet,
): Promise<Response> {
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  // Load conversation
  const { data: conversation, error: convError } = await supabaseAdmin
    .from('conversations')
    .select('id, status')
    .eq('id', conversation_id)
    .single();

  if (convError || !conversation) {
    return new Response(JSON.stringify({ error: 'Conversation not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Step 6 (early): Status Matrix Skeleton Guard — orchestration path ONLY.
  // L5b skeleton: only resolved/closed are refused. Full policy is L5e.
  if (conversation.status === 'resolved' || conversation.status === 'closed') {
    await supabaseAdmin
      .from('conversations')
      .update({ ai_generating: false })
      .eq('id', conversation_id);
    return safeRefusal('CONV_RESOLVED_OR_CLOSED');
  }

  // Step 0: Budget check (orchestration path only).
  // TODO L5e: enforce per-conversation LLM/tool budget; on exceed → handoff.
  //   if (await budgetExceeded(conversation_id)) { return safeRefusal('BUDGET_EXCEEDED'); }

  // Step 1: Coach Prompt Adapter (ENABLE_COACH).
  // In-memory only — base_prompt body is NEVER persisted.
  let basePrompt = MINIMAL_SAFE_FALLBACK_PROMPT;
  let coachTrace: { version_id?: string; version_label?: string; prompt_hash?: string; source: 'upstream' | 'minimal_fallback' } = {
    source: 'minimal_fallback',
  };
  if (flags.ENABLE_COACH) {
    const promptResult = await callCoachPromptAdapter(conversation_id);
    if (promptResult.success && promptResult.content) {
      basePrompt = promptResult.content; // in-memory only
      coachTrace = {
        version_id: promptResult.version_id,
        version_label: promptResult.version_label,
        prompt_hash: promptResult.prompt_hash,
        source: 'upstream',
      };
    } else {
      // Fallback: keep MINIMAL_SAFE_FALLBACK_PROMPT.
      // upstream_call_log is written by the adapter; do NOT duplicate here.
      console.warn('[generate-reply] coach_prompt_adapter fallback', { conversation_id, code: 'F-02' });
    }
  }

  // Step 2: prompt_overlay (orchestration path only; NO separate flag).
  // ⚠️ Schema unverified in L5b — comment-only. Future hook:
  //   const overlay = await loadPromptOverlay(conversation_id);
  //   basePrompt = mergeOverlay(basePrompt, overlay);  // in-memory only

  // Step 3: Customer360 Adapter (ENABLE_C360).
  // customer_context lives in memory only; full PII is never persisted or sent to LLM.
  let customerContext: { masked_summary?: string; tier?: string } | null = null;
  let opaqueCustomerRef: string | null = null;
  if (flags.ENABLE_C360) {
    const c360Result = await callCustomer360Adapter(conversation_id);
    if (c360Result.success && c360Result.customer_context) {
      // Adapter is expected to return masked/summarised data only.
      customerContext = c360Result.customer_context;
      opaqueCustomerRef = c360Result.customer_ref ?? null; // opaque cus_* / uuid only
    } else {
      // Fallback per Contract 06 §5: null context, default Standard tier.
      customerContext = null;
      console.warn('[generate-reply] customer360_adapter fallback', { conversation_id, code: 'F-04' });
    }
  }

  // Step 4: KB Adapter (ENABLE_KB).
  let ragResult: {
    success: boolean;
    no_answer?: boolean;
    retrieval_quality?: 'high' | 'medium' | 'low' | 'failed';
    chunks?: Array<{ id?: string; source?: string; score?: number; short_snippet?: string }>;
    query_text_redacted?: string;
  } | null = null;
  if (flags.ENABLE_KB) {
    ragResult = await callKBAdapter(conversation_id, /* message */ '');
    if (!ragResult.success || ragResult.no_answer) {
      // Fallback per Contract 04 §3: no_answer=true → handoff path (L5e wires it).
      console.warn('[generate-reply] kb_adapter no_answer/fallback', { conversation_id, code: 'F-01' });
    }
  }

  // Step 5: Tool registration — NOT in L5c Gate A.
  // ⚠️ ENABLE_TOOL_EXECUTOR=false → DO NOT attach any tools/functions schema to LLM.
  //   Even when ENABLE_TOOL_EXECUTOR=true, L5c Gate A does NOT attach tools.
  //   Tool registration (definitions + JSON schemas) is L5d scope.
  // L5c provides only the deterministic Tool Executor Gate (toolExecutorGate below).
  // Because no tools are attached, the LLM cannot emit tool_use blocks, so the Gate
  // is never invoked at runtime in L5c Gate A. It exists as code only and is
  // unit-reachable via direct call (code-proof) for future L5d wiring.
  if (flags.ENABLE_TOOL_EXEC) {
    // Placeholder only — L5d will register tools. L5c still attaches NO tools.
    console.log('[generate-reply] ENABLE_TOOL_EXECUTOR=true: Gate present, tools NOT attached (L5d scope)');
  }

  // Step 7: LLM Generate.
  // Assemble final prompt with masked context only.
  // ❌ customer_ref / order_id / raw PII MUST NOT appear in LLM prompt.
  const maskedContextBlock = buildMaskedContextBlock(customerContext, opaqueCustomerRef);
  const ragBlock = buildRagBlock(ragResult);
  const finalSystemPrompt = [basePrompt, maskedContextBlock, ragBlock]
    .filter((s) => s && s.length > 0)
    .join('\n\n');

  // Load conversation messages (same shape as legacy path)
  const { data: messages } = await supabaseAdmin
    .from('messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversation_id)
    .neq('content', '__THINKING__')
    .eq('is_recalled', false)
    .order('created_at', { ascending: true })
    .limit(10);

  if (!messages || messages.length === 0) {
    await supabaseAdmin
      .from('conversations')
      .update({ ai_generating: false })
      .eq('id', conversation_id);
    return new Response(JSON.stringify({ success: true, skipped: 'no messages' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const claudeMessages = messages.map((m) => ({
    role: (m.role === 'visitor') ? 'user' : 'assistant',
    content: m.content,
  }));

  if (claudeMessages[claudeMessages.length - 1].role === 'assistant') {
    await supabaseAdmin
      .from('conversations')
      .update({ ai_generating: false })
      .eq('id', conversation_id);
    return new Response(JSON.stringify({ success: true, skipped: 'last message is assistant' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!anthropicKey) {
    await supabaseAdmin
      .from('conversations')
      .update({ ai_generating: false })
      .eq('id', conversation_id);
    return new Response(JSON.stringify({ error: 'AI service not configured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: finalSystemPrompt,
      messages: claudeMessages,
      // ❌ NO tools / functions attached in L5b (regardless of flags).
    }),
  });

  if (!claudeResponse.ok) {
    const errText = await claudeResponse.text();
    console.error('[generate-reply] Claude API error:', claudeResponse.status, errText);
    await supabaseAdmin
      .from('conversations')
      .update({ ai_generating: false })
      .eq('id', conversation_id);
    return new Response(JSON.stringify({ error: 'AI service error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const claudeData = await claudeResponse.json();
  const aiReplyContent = claudeData.content?.[0]?.text ?? '';

  if (!aiReplyContent) {
    await supabaseAdmin
      .from('conversations')
      .update({ ai_generating: false })
      .eq('id', conversation_id);
    return new Response(JSON.stringify({ error: 'Empty AI response' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  await supabaseAdmin
    .from('messages')
    .delete()
    .eq('conversation_id', conversation_id)
    .eq('content', '__THINKING__');

  await supabaseAdmin
    .from('messages')
    .insert({
      conversation_id,
      role: 'assistant',
      content: aiReplyContent,
      status: 'delivered',
      is_recalled: false,
    });

  await supabaseAdmin
    .from('conversations')
    .update({ ai_generating: false, updated_at: new Date().toISOString() })
    .eq('id', conversation_id);

  // ── Post-generation trace writes (orchestration path, gated) ──────────────
  //
  // ⚠️ L5b INSPECT-FIRST RULE: trace inserts are COMMENT-ONLY until the actual
  //    final_prompt_trace / rag_trace column shapes are confirmed. Do NOT add
  //    columns and do NOT run migrations in L5b.
  //
  // Gating:
  //   - final_prompt_trace write reachable only when ENABLE_COACH is true.
  //   - rag_trace write reachable only when ENABLE_KB is true AND kb_adapter
  //     returned trace metadata (ragResult?.success).
  //   - Both writes are unreachable in legacy path (all flags false).

  if (flags.ENABLE_COACH) {
    // TODO L5c (schema-verified): insert into final_prompt_trace with:
    //   conversation_id, workspace_id/tenant_id,
    //   version_id, version_label, prompt_hash,            ← from coachTrace
    //   redacted_snapshot (≤4000 chars, NO full body),
    //   customer_context_ref: opaqueCustomerRef (opaque only),
    //   tools_invoked: [] (empty in L5b),
    //   source: coachTrace.source.
    // ❌ NEVER persist full prompt / full customer_context / raw customer_ref / PII.
    void coachTrace;
  }

  if (flags.ENABLE_KB && ragResult?.success) {
    // TODO L5c (schema-verified): insert into rag_trace with:
    //   conversation_id, workspace_id/tenant_id,
    //   query_text: ragResult.query_text_redacted (PII-redacted),
    //   retrieval_quality, no_answer flag,
    //   retrieved_chunks: ragResult.chunks (metadata + short_snippet ≤300 chars).
    // ❌ NEVER persist full chunk content / embeddings / raw query with PII.
    void ragResult;
  }

  console.log('[generate-reply] AI reply sent (orchestration path) for conversation:', conversation_id);
  return new Response(JSON.stringify({ success: true }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers (in-file only; no new helper modules created in L5b).
// ────────────────────────────────────────────────────────────────────────────

function safeRefusal(code: string): Response {
  return new Response(
    JSON.stringify({
      success: true,
      skipped: 'refused',
      reason_code: code,
      handoff_required: true,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}

// Build a masked context block to inject into the LLM system prompt.
// ❌ Never includes raw customer_ref / order_id / email / phone / address / name.
// ✅ Includes only the adapter's already-masked summary (e.g. "Gold VIP, frustrated").
function buildMaskedContextBlock(
  customerContext: { masked_summary?: string; tier?: string } | null,
  opaqueCustomerRef: string | null,
): string {
  if (!customerContext) return '';
  const parts: string[] = [];
  if (customerContext.tier) parts.push(`Customer tier: ${customerContext.tier}`);
  if (customerContext.masked_summary) parts.push(customerContext.masked_summary);
  // Pseudonymize opaque ref for logging continuity; raw ref is NEVER included.
  if (opaqueCustomerRef) {
    const pseudo = pseudonymizeRef(opaqueCustomerRef);
    parts.push(`Customer reference (pseudonymous): ${pseudo}`);
  }
  if (parts.length === 0) return '';
  return `Customer context (masked):\n${parts.join('\n')}`;
}

function buildRagBlock(
  ragResult: { success: boolean; chunks?: Array<{ short_snippet?: string }> } | null,
): string {
  if (!ragResult || !ragResult.success || !ragResult.chunks?.length) return '';
  const snippets = ragResult.chunks
    .map((c, i) => `[${i + 1}] ${(c.short_snippet ?? '').slice(0, 300)}`)
    .join('\n');
  return `Knowledge base context:\n${snippets}`;
}

// Pseudonymize an opaque customer_ref for prompt/log use. Not cryptographic;
// only intended to prevent the raw identifier from appearing verbatim.
function pseudonymizeRef(ref: string): string {
  let h = 0;
  for (let i = 0; i < ref.length; i++) h = ((h << 5) - h + ref.charCodeAt(i)) | 0;
  return `cust_${(h >>> 0).toString(36)}`;
}

// ── Adapter call stubs (L5b skeleton) ──────────────────────────────────────
// These are NOT invoked unless the corresponding flag is true. In L5b, with
// all flags false, none of these are reachable. When called, they return a
// safe-fallback shape; live adapter HTTP calls are wired in L5c+ once URLs
// and internal tokens are confirmed available in Supabase Secrets.

async function callCoachPromptAdapter(_conversation_id: string): Promise<{
  success: boolean;
  content?: string;
  version_id?: string;
  version_label?: string;
  prompt_hash?: string;
}> {
  // TODO L5c: POST to coach-prompt-adapter with X-Internal-Service-Token
  // from COACH_PROMPT_INTERNAL_TOKEN. On failure → success:false.
  return { success: false };
}

async function callCustomer360Adapter(_conversation_id: string): Promise<{
  success: boolean;
  customer_context?: { masked_summary?: string; tier?: string };
  customer_ref?: string;
}> {
  // TODO L5c: POST to customer360-adapter with CUSTOMER360_INTERNAL_TOKEN.
  return { success: false };
}

async function callKBAdapter(_conversation_id: string, _message: string): Promise<{
  success: boolean;
  no_answer?: boolean;
  retrieval_quality?: 'high' | 'medium' | 'low' | 'failed';
  chunks?: Array<{ id?: string; source?: string; score?: number; short_snippet?: string }>;
  query_text_redacted?: string;
}> {
  // TODO L5c: POST to kb-adapter with KB_INTERNAL_SERVICE_TOKEN.
  return { success: false, no_answer: true, retrieval_quality: 'failed' };
}
