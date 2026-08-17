#!/usr/bin/env python3
from pathlib import Path
import re,sys
root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
s=(root/"sql/pr29/pr29_task2_methodology_safeupdate_fix.sql").read_text()

def need(p,label,flags=0):
    if not re.search(p,s,flags):
        raise SystemExit(f"FAIL {label}")
    print("PASS",label)

need(r"CREATE OR REPLACE FUNCTION public\.ce_activate_evaluation_methodology_v1","function replacement")
need(r"WHERE s\.current_evaluation_fingerprint IS DISTINCT FROM v_fingerprint","safeupdate WHERE")
need(r"p_mark_existing_stale boolean DEFAULT false","no automatic backfill")
need(r"WHERE s\.last_success_fingerprint IS DISTINCT FROM v_fingerprint","explicit stale policy WHERE")
need(r"pg_advisory_xact_lock","activation serialization")
need(r"REVOKE ALL ON FUNCTION public\.ce_activate_evaluation_methodology_v1","RPC restricted")
need(r"GRANT EXECUTE ON FUNCTION public\.ce_activate_evaluation_methodology_v1.*TO service_role","service role only",re.S)

# Guard against the exact production blocker recurring.
bad=re.search(
    r"UPDATE public\.ce_evaluation_state(?:\s+s)?\s+SET\s+current_evaluation_fingerprint\s*=\s*v_fingerprint,\s+updated_at\s*=\s*now\(\)\s*;",
    s,re.S
)
if bad:
    raise SystemExit("FAIL WHERE-less ce_evaluation_state update reintroduced")
print("PASS no WHERE-less state update")
print("PR29 SAFEUPDATE FIX CONTRACT: PASS")
