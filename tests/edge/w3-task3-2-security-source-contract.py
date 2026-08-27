#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
rt=(r/"scripts/pr10-two-tenant-security-runtime-smoke.sh").read_text()
sg=(r/"scripts/pr10-two-tenant-security-source-gate.sh").read_text()
fg=(r/"scripts/w3-task3-2-security-final-gate.sh").read_text()
assert '"x-api-key":key' in rt
assert '"company_id":int(company_id)' in rt
assert '"selected_documents"' in rt
assert '"max_summary_chunks":1' in rt
assert '"max_full_content_chunks":3' in rt
assert 'Authorization":"Bearer' not in rt
assert '"max_summary":1' not in rt
assert '"max_full_chunks":3' not in rt
assert 'pr10-cross-tenant-edge-api-source-gate.sh' in fg
assert 'pr10-cross-tenant-mutation-write-source-gate.sh' in fg
assert 'pr7-production-atomic-rollback-source-gate.sh' in fg
assert 'npm run build' in fg
assert 'pr10-cross-tenant-edge-api-runtime-smoke.sh' in fg
assert 'pr10-cross-tenant-mutation-write-runtime-smoke.sh' in fg
print("PASS W3 Task 3.2 source contract")

edge=(r/"scripts/pr10-cross-tenant-edge-api-source-gate.sh").read_text()
assert "Customer360 uses canonical scope helper" in edge
assert "Agent Assist resolves canonical conversation boundary" in edge
assert "provider/grounding occurs only after canonical tenant denial guards" in edge

# Director takeover: provider-order validator must inspect awaited calls inside request handling.
edge=(r/"scripts/pr10-cross-tenant-edge-api-source-gate.sh").read_text()
assert "aa_body=aa[aa_serve:]" in edge
assert "aa_provider=p(aa_body,'await callClaude(')" in edge
assert "ce_scope=p(ce_handle,'const scope = await resolveEvaluationScope')" in edge
assert "mem_guard=p(ce_resolve,'if (!members || members.length === 0)')" in edge
