#!/usr/bin/env python3
from pathlib import Path
import sys
root=Path(sys.argv[1] if len(sys.argv)>1 else '.')
g=(root/'supabase/functions/generate-reply/index.ts').read_text()
p=(root/'supabase/functions/_shared/escalation-policy.ts').read_text()
router_path=root/'supabase/functions/_shared/llm-router.ts'
r=router_path.read_text() if router_path.exists() else ''

# No direct provider construction remains in the production Widget generation chain.
for src,name in [(g,'generate-reply'),(p,'escalation-policy')]:
    assert 'api.anthropic.com' not in src, name
    assert 'x-api-key' not in src, name
    assert 'claude-haiku-4-5-20251001' not in src, name
    assert 'ANTHROPIC_API_KEY' not in src, name

assert 'import { callModel, resolveGenerationMaxTokens, type LlmFailureCode } from "../_shared/llm-router.ts";' in g
assert g.count('callModel({') >= 2
assert 'tag: "generate-reply-legacy"' in g
assert 'tag: "generate-reply-orchestration"' in g
assert 'purpose: "generation"' in g
assert 'LLM_MODEL_GENERATION' in g
assert 'routerFailureToS0' in g
assert 'buildRouterConversationInput' in g

assert 'import { callModel, parseJsonObject, resolveGenerationMaxTokens } from "./llm-router.ts";' in p
assert 'responseFormat: "json"' in p
assert 'responseSchema: POLICY_RESPONSE_SCHEMA' in p
assert 'tag: "generate-reply-r4-policy"' in p
assert 'company_id: _pr5ExpectedTenantId ?? null' in g
assert 'operation_id: `generate-reply:r4-policy:' in g

# Frozen production safety paths must remain present.
for token in [
  'explicit_handoff_tx',
  'commit_ai_reply_tx',
  'kb_fallback_handoff_tx',
  's0_handoff_tx',
  'evaluateAndPersistRequiredRulesLive',
  'fetchKBRag',
  'full_content_evidence',
  'orientation_summary',
  'toolExecutorGate',
  'determineOutputMode',
  'source_already_replied',
  'superseded_source',
]:
    assert token in g, token

# Shared router remains the provider boundary and owns retry/redaction/usage logs.
# In the self-contained replacement folder the unchanged router may be absent;
# in the authoritative worktree final-gate it MUST exist and these assertions run.
if router_path.exists():
    for token in [
      'LLM_PROVIDER',
      'LLM_MODEL_GENERATION',
      'GOOGLE_SERVICE_ACCOUNT_JSON',
      'redact(call.system)',
      'redact(call.user)',
      'MAX_ATTEMPTS = 3',
      'upstream_call_log',
      'ANTHROPIC_ENDPOINT',
    ]:
        assert token in r, token

# generate-reply must not double-write upstream provider usage.
assert '.from("upstream_call_log").insert' not in g
assert 'system_prompt_snapshot: "[governed_generation_router_v1]"' in g

print('WIDGET PRODUCTION LLM ROUTER ALIGNMENT CONTRACT: PASS')
