#!/usr/bin/env python3
from pathlib import Path
import sys

root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
kb=(root/"supabase/functions/_shared/kb-client.ts").read_text()
auth=(root/"supabase/functions/_shared/kb-auth.ts").read_text()

required_kb=[
  'KB_SINGAPORE_TENANT_API_KEYS_JSON',
  'KB_SINGAPORE_API_KEY_HEADER',
  'resolveSingaporeCredential(scope,endpointCfg)',
  'singaporeCredentialHeaders(credential,endpointCfg)',
  'headers:{"Content-Type":"application/json",...authHeaders}',
  'fetchSelectedDocumentMetadata(endpointCfg,authHeaders',
]
for x in required_kb:
    assert x in kb, x

required_auth=[
  'cfg.tenantApiKeys[scope.singaporeTenantId]',
  'kind: "api_key"',
  'KB_AUTH_API_KEY_INVALID',
  'credential.kind === "api_key"',
  'cfg.apiKeyHeaderMode === "x-api-key"',
  'Authorization: `Bearer ${credential.value}`',
]
for x in required_auth:
    assert x in auth, x

# Guardrails
assert 'company_id' not in kb[kb.index('JSON.stringify({query'):kb.index('JSON.stringify({query')+300]
assert 'tenant_id' not in kb[kb.index('JSON.stringify({query'):kb.index('JSON.stringify({query')+300]
assert 'console.log' not in auth
assert 'console.log' not in kb
print("PR27 KB COMPANY API KEY CONTRACT: PASS")
