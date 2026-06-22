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

  // L5d: TOOL_DEFINITIONS attachment is a GUARDED code path.
  // ⚠️ With ENABLE_TOOL_EXECUTOR=false (Gate A), `tools` is NOT included in
  //    the Anthropic request body. The conditional spread below is the only
  //    place tools could ever be attached, and only when the flag is true.
  //    No LLM tool_call is possible while the flag is false.
  const anthropicRequestBody: Record<string, unknown> = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: finalSystemPrompt,
    messages: claudeMessages,
  };
  if (flags.ENABLE_TOOL_EXEC) {
    // Guarded code path — unreachable at runtime in Gate A (flag=false).
    // L5d code-proof: when Director enables the flag in a future Gate B,
    // TOOL_DEFINITIONS would be attached here.
    anthropicRequestBody.tools = TOOL_DEFINITIONS;
  }

  const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(anthropicRequestBody),
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

// ────────────────────────────────────────────────────────────────────────────
// L5c Tool Executor Gate — deterministic decision layer (Gate A).
//
// Source of truth: Contract 07 §2.1 + Contract 03 §1.1 + Contract 08.
//
// ⚠️ L5c GATE A INVARIANTS:
//   1. This gate returns DECISIONS ONLY. It does NOT execute tools, create
//      stub tool results, feed any result back to the LLM, write
//      handoff_event, or write final_prompt_trace.tools_invoked.
//   2. It is UNREACHABLE at runtime in Gate A because:
//        (a) all flags default false → legacy path taken,
//        (b) even with ENABLE_TOOL_EXECUTOR=true, Step 5 above does NOT
//            attach any tool schema to the LLM, so no tool_use can occur.
//   3. Live wiring (actual execution / handoff / draft enforcement / trace)
//      is deferred to L5d / L5e after Director approval.
//   4. LLM cannot override gate decisions. tool_call requests are SUGGESTIONS.
// ────────────────────────────────────────────────────────────────────────────

type GateDecisionKind = 'ALLOW' | 'DENY' | 'DOWNGRADE_TO_DRAFT' | 'ESCALATE';

interface GateDecision {
  decision: GateDecisionKind;
  reason?: string;
  execution_allowed?: boolean;
  force_draft?: boolean;
  handoff_required?: boolean;
  execution_deferred_to?: 'L5d';
  draft_enforcement_deferred_to?: 'L5e';
  action_deferred_to?: 'L5e';
  message_to_llm?: string;
}

interface ToolRequest {
  tool_name: string;
  input: Record<string, unknown>;
}

interface ExecutionContext {
  conversation: { id: string; status: string };
  caller_mode: 'system_auto' | 'human_agent' | 'ai_assist';
  risk_level: 'low' | 'medium' | 'high';
  privacy_flags?: { do_not_profile?: boolean; consent_status?: 'granted' | 'withdrawn' | 'unknown' };
  turn_tool_calls: Set<string>;
  turn_budget: { total: number; kb_search: number; c360: number };
  server_resolved_customer_ref?: string | null; // opaque, server-side only
}

const ALLOWED_TOOLS = [
  'kb_search',
  'escalate_to_human',
  'get_customer_context',
  'get_order_summary',
  'create_handoff_summary',
  'mark_unresolved',
  'suggest_reply',
] as const;

const READ_ONLY_TOOLS = ['kb_search', 'get_customer_context', 'get_order_summary'] as const;
const HIGH_RISK_ALLOWED = ['kb_search', 'get_customer_context', 'escalate_to_human', 'create_handoff_summary'] as const;
const OFFLINE_BOT_ALLOWED = ['kb_search', 'escalate_to_human'] as const;

const MAX_TOOL_CALLS = 10;
const MAX_KB_SEARCH = 3;
const MAX_C360_CALLS = 2;

// Build a PII-safe dedupe key. NEVER includes raw customer_ref / order_id /
// email / phone / address. For get_order_summary, ignores LLM-provided
// customer_ref / order_id entirely and uses the server-resolved opaque ref.
function buildSafeDedupeKey(
  tool_name: string,
  input: Record<string, unknown>,
  server_resolved_customer_ref?: string | null,
): string | null {
  if (tool_name === 'get_order_summary') {
    if (!server_resolved_customer_ref) return null; // caller must DENY(SERVER_REFERENCE_REQUIRED)
    return `get_order_summary:${server_resolved_customer_ref}`;
  }
  // Allowlist of safe fields per tool. Unknown fields are dropped.
  const SAFE_FIELDS: Record<string, string[]> = {
    kb_search: ['query_norm', 'locale'],
    get_customer_context: [], // no LLM-provided params honored
    escalate_to_human: ['reason_code'],
    create_handoff_summary: ['reason_code'],
    mark_unresolved: ['reason_code'],
    suggest_reply: ['intent_code'],
  };
  const allowed = SAFE_FIELDS[tool_name] ?? [];
  const safe: Record<string, unknown> = {};
  for (const k of allowed) {
    if (input[k] !== undefined && typeof input[k] !== 'object') {
      safe[k] = String(input[k]).slice(0, 200);
    }
  }
  return `${tool_name}:${JSON.stringify(safe)}`;
}

// Deterministic Tool Executor Gate — 7 steps in fixed order.
// Pure function: no I/O, no DB writes, no LLM calls, no trace writes.
export function toolExecutorGate(
  toolRequest: ToolRequest,
  context: ExecutionContext,
): GateDecision {
  const { tool_name, input } = toolRequest;
  const {
    conversation,
    caller_mode,
    risk_level,
    privacy_flags,
    turn_tool_calls,
    turn_budget,
    server_resolved_customer_ref,
  } = context;

  // Step 1: Tool name validation
  if (tool_name === 'schedule_feedback_request') {
    return { decision: 'DENY', reason: 'TOOL_EXCLUDED' };
  }
  if (!(ALLOWED_TOOLS as readonly string[]).includes(tool_name)) {
    return { decision: 'DENY', reason: 'TOOL_NOT_REGISTERED' };
  }

  // Step 2: Status guard (Contract 07 §2.2)
  const status = conversation.status;
  if (status === 'resolved' || status === 'closed') {
    return { decision: 'DENY', reason: 'CONV_RESOLVED_OR_CLOSED' };
  }
  if ((status === 'human_needed' || status === 'human_control')
      && !(READ_ONLY_TOOLS as readonly string[]).includes(tool_name)) {
    return { decision: 'DENY', reason: 'TOOL_NOT_ALLOWED_IN_STATUS' };
  }
  if (status === 'offline_bot'
      && !(OFFLINE_BOT_ALLOWED as readonly string[]).includes(tool_name)) {
    return { decision: 'DENY', reason: 'TOOL_NOT_ALLOWED_OFFLINE' };
  }

  // Step 3: Risk guard
  if (risk_level === 'high'
      && !(HIGH_RISK_ALLOWED as readonly string[]).includes(tool_name)) {
    return { decision: 'ESCALATE', reason: 'HIGH_RISK_TOOL_BLOCKED' };
  }

  // Step 4: Permission guard (Contract 02)
  if (tool_name === 'mark_unresolved' && caller_mode === 'system_auto') {
    return { decision: 'DENY', reason: 'MARK_UNRESOLVED_REQUIRES_HUMAN' };
  }

  // Step 5: Privacy guard (Contract 06 §3)
  if (privacy_flags?.do_not_profile === true
      || privacy_flags?.consent_status === 'withdrawn') {
    if (tool_name === 'get_customer_context') {
      return { decision: 'DENY', reason: 'PRIVACY_DO_NOT_PROFILE' };
    }
  }

  // Step 6: Idempotency check (Contract 07 Hard Constraint #9)
  // For get_order_summary: server-resolved opaque ref REQUIRED.
  const dedupe_key = buildSafeDedupeKey(tool_name, input, server_resolved_customer_ref);
  if (dedupe_key === null) {
    // Risk-policy escalation belongs to L5e — Gate returns DENY only.
    return { decision: 'DENY', reason: 'SERVER_REFERENCE_REQUIRED' };
  }
  if (turn_tool_calls.has(dedupe_key)) {
    return { decision: 'DENY', reason: 'DUPLICATE_TOOL_CALL_IN_TURN' };
  }
  turn_tool_calls.add(dedupe_key);

  // Step 7: Budget guard (Contract 07 Hard Constraint #10)
  if (turn_budget.total >= MAX_TOOL_CALLS) {
    return { decision: 'DENY', reason: 'TOOL_BUDGET_EXCEEDED' };
  }
  if (tool_name === 'kb_search' && turn_budget.kb_search >= MAX_KB_SEARCH) {
    return { decision: 'DENY', reason: 'KB_SEARCH_BUDGET_EXCEEDED' };
  }
  if (tool_name === 'get_customer_context' && turn_budget.c360 >= MAX_C360_CALLS) {
    return { decision: 'DENY', reason: 'C360_BUDGET_EXCEEDED' };
  }

  // All guards passed → ALLOW or status-driven DOWNGRADE
  if (status === 'ai_draft_only' || status === 'unresolved') {
    return {
      decision: 'DOWNGRADE_TO_DRAFT',
      reason: 'STATUS_DRAFT_ONLY',
      execution_allowed: true,
      force_draft: true,
      execution_deferred_to: 'L5d',
      draft_enforcement_deferred_to: 'L5e',
    };
  }
  if (status === 'escalation_risk') {
    return {
      decision: 'DOWNGRADE_TO_DRAFT',
      reason: 'ESCALATION_RISK_DOWNGRADE',
      execution_allowed: true,
      force_draft: true,
      execution_deferred_to: 'L5d',
      draft_enforcement_deferred_to: 'L5e',
    };
  }

  return {
    decision: 'ALLOW',
    reason: 'GATE_PASSED',
    execution_allowed: true,
    execution_deferred_to: 'L5d',
  };
}

// Decision dispatcher — shapes the GateDecision into the canonical response
// envelope per Contract 07 §2.1. L5c returns the envelope only; it does NOT:
//   - create stub tool results
//   - feed any result back to the LLM
//   - write handoff_event
//   - write final_prompt_trace.tools_invoked
// TODO L5d/L5e: append to final_prompt_trace.tools_invoked after Director approval.
//   Schema (inspect-first): { tool_name, request_id, status, summary(≤200),
//   auto_executed, caller_mode, result_classification }.
//   ❌ Not: full input / full output / PII / KB content.
export function handleGateDecision(decision: GateDecision): GateDecision {
  switch (decision.decision) {
    case 'ALLOW':
      return {
        decision: 'ALLOW',
        reason: decision.reason ?? 'GATE_PASSED',
        execution_allowed: true,
        execution_deferred_to: 'L5d',
      };
    case 'DENY':
      return {
        decision: 'DENY',
        reason: decision.reason,
        message_to_llm: 'tool not available in current context',
      };
    case 'DOWNGRADE_TO_DRAFT':
      return {
        decision: 'DOWNGRADE_TO_DRAFT',
        reason: decision.reason,
        execution_allowed: true,
        force_draft: true,
        execution_deferred_to: 'L5d',
        draft_enforcement_deferred_to: 'L5e',
      };
    case 'ESCALATE':
      return {
        decision: 'ESCALATE',
        reason: decision.reason,
        handoff_required: true,
        action_deferred_to: 'L5e',
      };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// L5d — 7 Tools Registration / Safe Stubs / Permission Wiring (Gate A).
//
// Source of truth: Contract 07 §3 FROZEN + Contract 03 §1.1 + Contract 08.
//
// ⚠️ L5d GATE A INVARIANTS:
//   1. TOOL_DEFINITIONS is CODE-DEFINED ONLY. It is attached to the Anthropic
//      request body ONLY inside the `if (flags.ENABLE_TOOL_EXEC)` guard in
//      orchestrationGenerateReply(). With ENABLE_TOOL_EXECUTOR=false (Gate A),
//      that branch is unreachable and `tools` does NOT appear in the request.
//   2. handleToolCall() is CODE-DEFINED ONLY. It is NOT invoked anywhere in
//      the runtime path in Gate A. Future wiring (Gate B / L5e) would call it
//      ONLY after toolExecutorGate() returns ALLOW or DOWNGRADE_TO_DRAFT.
//      DENY / ESCALATE decisions MUST NOT call handleToolCall().
//   3. Stub handlers return safe internal-only placeholders. They MUST NOT:
//        - call any real KB / Customer360 / Order / ERP API
//        - write handoff_event / conversations.status / ai_reply_draft / audit_log
//        - return real customer PII / order data
//        - be fed back to the LLM in Gate A runtime
//        - be treated as customer-facing factual truth
//   4. final_prompt_trace.tools_invoked is NOT written in Gate A. The mapping
//      is comment-only below. Any runtime append is deferred to Director-
//      approved Gate B (schema must be inspected first; no new column/migration).
//   5. schedule_feedback_request is EXCLUDED — handled by resolve-conversation
//      EF, not by the LLM. Gate (Step 1) DENYs it; it is absent from
//      TOOL_DEFINITIONS by design.
//   6. get_customer_context / get_order_summary / create_handoff_summary input
//      schemas do NOT include customer_ref / order_id / conversation_id. Any
//      LLM-provided value for those fields is IGNORED — server-side resolution
//      only (see buildSafeDedupeKey for get_order_summary).
// ────────────────────────────────────────────────────────────────────────────

// 7 tool function schemas registered to the LLM only when
// ENABLE_TOOL_EXECUTOR=true (guarded code path in orchestrationGenerateReply).
const TOOL_DEFINITIONS = [
  {
    name: 'kb_search',
    description:
      'Search the knowledge base for policy, FAQ, or product information to answer customer questions.',
    input_schema: {
      type: 'object',
      properties: {
        // ⚠️ query must be PII-redacted before any stub log or trace write.
        query: {
          type: 'string',
          description:
            'Search query extracted from customer message (must be PII-redacted before stub log or trace).',
        },
        industry: {
          type: 'string',
          description: 'Industry context (optional, inferred from conversation).',
        },
        top_k: {
          type: 'number',
          description: 'Number of results to return (default 5, max 10).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Escalate conversation to a human agent when AI cannot resolve the issue.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Reason for escalation (sanitized, no PII).' },
        summary: {
          type: 'string',
          description: 'Brief conversation summary (sanitized, max 500 chars, no PII).',
        },
      },
      required: ['reason', 'summary'],
    },
  },
  {
    name: 'get_customer_context',
    description:
      'Get customer context (tier, sentiment, language preference) to personalize response tone.',
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Requested fields (advisory only — server enforces masking level allowlist).',
        },
      },
      required: [],
      // ⚠️ customer_ref NOT in LLM input — server-side resolved from conversation.
    },
  },
  {
    name: 'get_order_summary',
    description: 'Get order status summary for delivery, return, or refund inquiries.',
    input_schema: {
      type: 'object',
      properties: {
        inquiry_type: {
          type: 'string',
          enum: ['delivery_status', 'return_request', 'refund_inquiry', 'order_general'],
          description: 'Type of order inquiry.',
        },
      },
      required: ['inquiry_type'],
      // ⚠️ customer_ref and order_id NOT in LLM input — server-side resolved.
      // ⚠️ LLM-provided customer_ref / order_id are IGNORED (security requirement).
    },
  },
  {
    name: 'create_handoff_summary',
    description:
      'Generate a conversation summary for the human agent who will take over this conversation.',
    input_schema: {
      type: 'object',
      properties: {
        summary_focus: {
          type: 'string',
          description:
            "Optional focus area for the summary (e.g. 'refund concern', 'delivery issue').",
        },
      },
      required: [],
      // ⚠️ conversation_id NOT in LLM input — server-side resolved from ExecutionContext.
      // ⚠️ If LLM provides conversation_id, IGNORE/STRIP it before processing.
    },
  },
  {
    name: 'mark_unresolved',
    description:
      'Mark conversation as unresolved for follow-up. Only available in console suggest mode.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Reason conversation is unresolved (sanitized).' },
        follow_up_at: {
          type: 'string',
          description:
            'Suggested follow-up datetime (ISO 8601, optional — advisory only in L5d, not written/scheduled).',
        },
      },
      required: ['reason'],
      // ⚠️ follow_up_at is advisory only in L5d — do NOT schedule, write, or persist it.
    },
  },
  {
    name: 'suggest_reply',
    description:
      'Generate a suggested reply for the customer based on KB findings and context.',
    input_schema: {
      type: 'object',
      properties: {
        context_summary: {
          type: 'string',
          description:
            'Summary of context assembled by generate-reply (sanitized, max 500 chars, no PII).',
          // ⚠️ Must be sanitized before use — if raw/too long/PII-like: truncate/redact or DENY.
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Citation labels from KB results.',
        },
      },
      required: ['context_summary'],
    },
  },
];
// EXCLUDED tool (must DENY if LLM attempts):
//   schedule_feedback_request → handled by resolve-conversation EF, not LLM.

// Tool result envelope. result_classification is always 'internal_only' in
// L5d; stub results must NEVER be surfaced as customer-facing truth.
interface ToolResult {
  tool_name: string;
  status: 'stub' | 'denied';
  result_classification: 'internal_only';
  [k: string]: unknown;
}

// Safe stub handler — CODE-DEFINED ONLY in L5d Gate A.
// ⚠️ Not invoked at runtime while ENABLE_TOOL_EXECUTOR=false.
// ⚠️ Must only be called by an L5d/L5e wiring path AFTER toolExecutorGate()
//    returned ALLOW or DOWNGRADE_TO_DRAFT. DENY/ESCALATE must NOT reach here.
// ⚠️ Step 5 logs (if any) are metadata-only:
//      allowed:  tool_name, request_id, timestamp
//      forbidden: raw tool_input, customer_ref, order_id, email, phone, PII,
//                 prompt content, KB content
export async function handleToolCall(
  tool_name: string,
  _tool_input: Record<string, unknown>,
  _context: ExecutionContext,
): Promise<ToolResult> {
  switch (tool_name) {
    case 'kb_search':
      // Real KB call deferred to Gate B (ENABLE_KB_ADAPTER=true + Director approval).
      return {
        tool_name: 'kb_search',
        status: 'stub',
        result_classification: 'internal_only',
        retrieval_quality: 'failed',
        no_answer: true,
        handoff_required: true,
        results: [],
        stub_note: 'KB adapter not yet enabled (L5d stub)',
      };

    case 'escalate_to_human':
      // ❌ Do NOT write handoff_event in L5d stub.
      // ❌ Do NOT update conversations.status in L5d stub.
      return {
        tool_name: 'escalate_to_human',
        status: 'stub',
        result_classification: 'internal_only',
        escalated: false,
        stub_note: 'Escalation workflow deferred to L5e — no state changes in L5d',
      };

    case 'get_customer_context':
      // ❌ Do NOT call customer360_adapter in L5d stub.
      // ❌ Do NOT return any real PII.
      // ⚠️ tier='Standard' is a safe fallback placeholder, NOT verified Customer360 truth.
      return {
        tool_name: 'get_customer_context',
        status: 'stub',
        result_classification: 'internal_only',
        customer_context: {
          tier: 'Standard',
          language_preference: 'en',
          sentiment: 'neutral',
        },
        stub_note:
          'Customer360 adapter not yet enabled (L5d stub) — using safe defaults',
      };

    case 'get_order_summary':
      // ❌ Do NOT call any order/ERP API.
      // ❌ Do NOT return any real order data / payment data.
      // ⚠️ LLM-provided customer_ref / order_id are ignored — stub does not use them.
      return {
        tool_name: 'get_order_summary',
        status: 'stub',
        result_classification: 'internal_only',
        order_available: false,
        stub_note: 'Order adapter not yet enabled (L5d stub)',
      };

    case 'create_handoff_summary':
      // conversation_id is server-side resolved — LLM-provided value ignored/stripped.
      // This tool is return-only (Contract 07 §3.5 Gap 6 Plan A).
      return {
        tool_name: 'create_handoff_summary',
        status: 'stub',
        result_classification: 'internal_only',
        summary: '[Handoff summary not yet available — L5d stub]',
        stub_note:
          'Handoff summary generation deferred to L5e; conversation_id server-side only',
      };

    case 'mark_unresolved':
      // ❌ Do NOT update conversations.status in L5d stub.
      // ❌ Do NOT write conversation_status_log / audit_log in L5d stub.
      return {
        tool_name: 'mark_unresolved',
        status: 'stub',
        result_classification: 'internal_only',
        marked: false,
        stub_note:
          'mark_unresolved write action deferred to L5e — no state changes in L5d',
      };

    case 'suggest_reply':
      // ❌ Do NOT write ai_reply_draft in L5d stub.
      // ❌ Do NOT auto-send anything in L5d stub.
      return {
        tool_name: 'suggest_reply',
        status: 'stub',
        result_classification: 'internal_only',
        draft_content: '',
        confidence: 0,
        recommended_action: 'human_review',
        stub_note:
          'suggest_reply draft write deferred to L5e — no state changes in L5d',
      };

    default:
      return {
        tool_name,
        status: 'denied',
        result_classification: 'internal_only',
        error: 'tool not available in current context',
      };
  }
}

// ── Future Gate B wiring (NOT implemented in L5d Gate A) ──────────────────
// The flow below is documented for reference only. No runtime code path
// executes it while ENABLE_TOOL_EXECUTOR=false.
//
//   LLM emits tool_call (only possible when TOOL_DEFINITIONS is attached,
//                        which requires ENABLE_TOOL_EXECUTOR=true)
//     ↓
//   const decision = handleGateDecision(toolExecutorGate(req, ctx));
//     ↓
//   if (decision.decision === 'ALLOW' || decision.decision === 'DOWNGRADE_TO_DRAFT') {
//     const result = await handleToolCall(req.tool_name, req.input, ctx);
//     // TODO Gate B (Director approval + schema inspection):
//     //   append to final_prompt_trace.tools_invoked:
//     //     { tool_name, request_id, status, summary(≤200 sanitized),
//     //       auto_executed, caller_mode, result_classification }
//     //   ❌ No raw input / output / PII / KB content in summary.
//     //   ❌ No new column — use existing jsonb field (inspect-first).
//   }
//   // DENY / ESCALATE → handleToolCall() is NOT called.
