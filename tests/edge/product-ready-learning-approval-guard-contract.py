#!/usr/bin/env python3
from pathlib import Path
import sys

root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
sync=(root/"supabase/functions/training-kb-sync/index.ts").read_text()
sql=(root/"sql/pr6b/pr6b_singapore_kb_sync_state.sql").read_text()

# "trained" alone is not enough.
assert 'decision !== "trained"' in sync
assert 'kb_update_not_verified_approved' in sync
assert 'su_coachai_verified_correction' in sync
assert 'approved_by' in sync
assert 'approved_at' in sync

# Approval must be checked before first Singapore mutation.
approval=sync.index('if (!approvedKbUpdate(kb))')
patch=sync.index('method: "PATCH"')
publish=sync.index('"/api/functions/kbPublishStart"')
assert approval < patch < publish

# Double tenant guard: mapped credential + returned KBDocument tenant.
assert 'kb_document_tenant_mismatch' in sync
assert 'aiCompanyId: companyId' in sync
assert 'singaporeTenantId: tenantId' in sync

# Version snapshot carries approval provenance and is approved, not pending.
assert 'review_status: "approved"' in sync
assert 'approval_source: APPROVAL_SOURCE' in sync

# SQL claim itself excludes unapproved learning results.
assert "COALESCE(l.payload->>'decision','')='trained'" in sql
assert "approval'->>'status','')='approved'" in sql
assert "approval'->>'source','')='su_coachai_verified_correction'" in sql
assert "approved_by" in sql
assert "approved_at" in sql

# Keep atomic/tenant state ownership with service role only.
assert "FOR UPDATE SKIP LOCKED" in sql
assert "GRANT EXECUTE ON FUNCTION public.claim_pr6b_kb_sync_tx() TO service_role" in sql

print("PASS product-ready learning approval guard source contract")
