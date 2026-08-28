#!/usr/bin/env python3
"""Task 3.3 consolidated product-ready source contract (A-F).

Machine-checked source guarantees only; this asserts nothing about runtime PASS.
The assertions intentionally target the previously observed false-PASS classes.
"""
from pathlib import Path
import re
import sys

r = Path(sys.argv[1] if len(sys.argv) > 1 else '.')


def read(p):
    f = r / p
    assert f.is_file() and f.stat().st_size > 0, f"missing/empty {p}"
    return f.read_text()


router = read('supabase/functions/_shared/llm-router.ts')
reply = read('supabase/functions/generate-reply/index.ts')
policy = read('supabase/functions/_shared/escalation-policy.ts')
crm = read('src/components/console/CRMPanel.tsx')
inbox = read('src/routes/_authenticated/console.conversations.index.tsx')
detail = read('src/routes/_authenticated/console.conversations.$id.tsx')
attach_fn = read('src/lib/api/attachments.functions.ts')
attach_sql = read('sql/pr30/pr30_agent_attachment.sql')
attach_rollback = read('sql/pr30/pr30_agent_attachment.rollback.sql')
msg_ui = read('src/components/console/MessageAttachment.tsx')
tools_ui = read('src/components/console/ComposerTools.tsx')
assist = read('supabase/functions/agent-assist/index.ts')

# ---- A: bounded configurable generation output budget, no 500 truncation ----
for marker in [
    'GENERATION_MAX_TOKENS_DEFAULT = 2048',
    'GENERATION_MAX_TOKENS_MIN = 768',
    'GENERATION_MAX_TOKENS_MAX = 8192',
    'export function resolveGenerationMaxTokens',
    'LLM_MAX_OUTPUT_TOKENS_GENERATION',
]:
    assert marker in router, f"A: {marker}"
assert 'Math.max(' in router and 'Math.min(' in router, "A: budget must be clamped"
for name, src in (('generate-reply', reply), ('escalation-policy', policy)):
    assert 'resolveGenerationMaxTokens' in src, f"A: {name} must use shared budget"
    assert 'maxTokens: 500' not in src, f"A: {name} still hard-codes 500"
for path in (r / 'supabase' / 'functions').rglob('*.ts'):
    text = path.read_text()
    for m in re.finditer(r'purpose:\s*"generation"', text):
        window = text[max(0, m.start() - 1500): m.start() + 1500]
        assert 'resolveGenerationMaxTokens' in window or 'maxTokens' not in window, \
            f"A: generation caller without shared budget: {path}"
assert 'MAX_TOKENS' in router and 'LLM_INVALID_OUTPUT' in router, "A: fail-closed truncation"

# ---- B: first ordinary no-match/low-score => one AI clarification turn ----
for marker in [
    'KB_NO_MATCH_CLARIFICATION_ROUTE',
    'isFirstNoMatchClarificationEligible',
    'attemptFirstNoMatchClarification',
    'clarification_new_intent_no_kb_match',
    'handoff_required: false',
    'commitAiReplyWithControlGate',
]:
    assert marker in reply, f"B: {marker}"

elig = reply[reply.index('export function isFirstNoMatchClarificationEligible'):]
elig = elig[:elig.index('\n}\n')]
for guard in [
    'KB_EMPTY', 'KB_LOW_SCORE_STANDARD', 'input.high_risk',
    'input.explicit_human_request', 'threat_flag',
    'compliance_requires_human_review', 'clarification_attempts > 0',
    'exact_same_intent_repeated',
]:
    assert guard in elig, f"B: eligibility guard missing: {guard}"

assert reply.count('threat_flag: _pr5ThreatSignal?.value === true') >= 2, \
    "B: no-match call sites must pass authoritative threat boolean value"
assert reply.count('compliance_requires_human_review: _pr5ComplianceSignal?.value === true') >= 2, \
    "B: no-match call sites must pass authoritative compliance boolean value"
assert 'compliance_requires_human_review: _pr5ComplianceSignal !== undefined' not in reply, \
    "B: false compliance object still incorrectly blocks clarification"
assert 'handleKBFallback' in reply and 'kb_fallback_handoff_tx' in reply, \
    "B: escalation fallback must remain fail-closed"

# ---- C: right-panel contextual relevance ----
for marker in [
    'KB_UI_MIN_RELEVANCE = 0.75',
    'export function filterRelevantKBResults',
    'export function deriveAutoSearchQuery',
    'selected_document_id',
    'full_content',
]:
    assert marker in crm, f"C: {marker}"
assert 'KB_UI_SELECTED_DOC_MIN_RELEVANCE = 0.65' not in crm, \
    "C: selected/full-content evidence cannot lower the acceptance threshold"
filter_src = crm[crm.index('export function filterRelevantKBResults'):]
filter_src = filter_src[:filter_src.index('\n}\n')]
assert 'r.score >= KB_UI_MIN_RELEVANCE' in filter_src, \
    "C: every displayed result must meet the hard 0.75 floor"
assert 'filterRelevantKBResults(' in crm
assert 'deriveAutoSearchQuery(boundedContext)' in crm
assert 'kbEmpty' in crm and 'No relevant knowledge found' in crm

# ---- D: Agent Assist regression guard ----
assert 'resolveGenerationMaxTokens' not in assist, "D: agent-assist budget must stay untouched"
for tool in ['translate', 'grammar', 'suggest_reply', 'check_policy']:
    assert tool in assist, f"D: agent-assist tool missing: {tool}"

# ---- E/F: composer + attachment security/control ----
for src_name, src in (('inbox', inbox), ('detail', detail)):
    assert 'coming soon' not in src, f"E: {src_name} still has disabled placeholders"
    assert 'EmojiPickerButton' in src, f"E: {src_name} emoji picker"
    assert 'AttachmentButtons' in src, f"E: {src_name} attachment buttons"
    assert 'MessageAttachment' in src, f"E: {src_name} attachment rendering"
    assert 'content_type' in src, f"E: {src_name} must select content_type"

assert 'insertAtCaret' in tools_ui and 'selectionStart' in tools_ui, "E: caret insertion"
assert 'MAX_ATTACHMENT_BYTES' in tools_ui and 'ALLOWED_ATTACHMENT_MIME' in tools_ui, "E: client guards"
assert 'TAKEOVER_RETRY_ERRORS' in tools_ui, "E: attachment takeover retry guard"
assert 'take-over-conversation' in tools_ui, "E: canonical takeover endpoint"
assert 'Exactly one retry' in tools_ui, "E: no unbounded takeover/send loop"

assert 'storage_path' not in msg_ui and 'storage_bucket' not in msg_ui, \
    "E: private storage locator leaked into browser attachment type"
assert 'createSignedUrl' in attach_fn
assert re.search(r'\.from\("message_attachment_private"(?:\s+as\s+never)?\)', attach_fn), \
    "E: signed URL must resolve locator server-side"
assert 'metadata["storage_path"]' not in attach_fn and 'metadata["storage_bucket"]' not in attach_fn, \
    "E: signed URL must not read private locators from message metadata"

for marker in [
    'widget-attachments',
    'MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024',
    'requireSupabaseAuth',
    'agent_send_attachment_tx',
    'remove([storagePath])',
    '.eq("company_id", scope.companyId)',
    'conversation.status === "resolved"',
    'conversation.assigned_agent_id',
]:
    assert marker in attach_fn, f"E: attachment server missing {marker}"
assert attach_fn.index('.upload(') > attach_fn.index('.eq("company_id", scope.companyId)'), \
    "E: tenant/control preflight must precede storage upload"

for marker in [
    'CREATE TABLE IF NOT EXISTS public.message_attachment_private',
    'ALTER TABLE public.message_attachment_private ENABLE ROW LEVEL SECURITY',
    'REVOKE ALL ON TABLE public.message_attachment_private FROM PUBLIC, anon, authenticated',
    'INSERT INTO public.message_attachment_private',
    'FOR UPDATE', 'resolved', 'human_control', "('image', 'video', 'file')",
    '10485760', 'REVOKE ALL ON FUNCTION public.agent_send_attachment_tx',
    'GRANT EXECUTE ON FUNCTION public.agent_send_attachment_tx',
]:
    assert marker in attach_sql, f"E: sql {marker}"

message_insert = attach_sql[attach_sql.index('INSERT INTO public.messages'):attach_sql.index('INSERT INTO public.message_attachment_private')]
assert "'storage_path'" not in message_insert and "'storage_bucket'" not in message_insert, \
    "E: public message metadata must not contain private locator"
assert 'DROP FUNCTION' in attach_rollback and 'DROP TABLE IF EXISTS public.message_attachment_private' in attach_rollback, \
    "E: rollback must cover RPC and private table"
assert 'service_role' in attach_sql, "F: privileged RPC/table restricted to service role"

print('PASS Task 3.3 consolidated product-ready source contract (A-F)')
