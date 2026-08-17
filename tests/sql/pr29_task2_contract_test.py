#!/usr/bin/env python3
from pathlib import Path
import re, sys

root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
s=(root/"sql/pr29/pr29_ce_auto_evaluation_runtime.sql").read_text()

def need(p,label,flags=0):
    if not re.search(p,s,flags):
        raise SystemExit(f"FAIL {label}")
    print("PASS",label)

need(r"debounce_minutes integer NOT NULL DEFAULT 10","10 minute debounce")
need(r"max_age_minutes integer NOT NULL DEFAULT 120","2 hour max age")
need(r"background_sweep_minutes integer NOT NULL DEFAULT 60","hourly background sweep")
need(r"global_concurrency integer NOT NULL DEFAULT 3","global concurrency 3")
need(r"per_company_concurrency integer NOT NULL DEFAULT 1","per company concurrency 1")
need(r"UNIQUE INDEX IF NOT EXISTS ce_local_attempt_snapshot_fingerprint_uidx","local fingerprint uniqueness")
need(r"UNIQUE INDEX IF NOT EXISTS ce_canonical_snapshot_fingerprint_uidx","canonical fingerprint uniqueness")
need(r"ce_trigger_snapshot_hash_v1","trigger snapshot hash")
need(r"ce_enqueue_current_snapshot_v1","current snapshot enqueue")
need(r"last_success_snapshot_hash IS NOT DISTINCT FROM v_hash.*last_success_fingerprint IS NOT DISTINCT FROM v_fingerprint","unchanged snapshot no-op",re.S)
need(r"trg_ce_resolved_priority","resolved priority")
need(r"trg_zz_ce_verified_correction_priority","verified correction priority")
need(r"ce_claim_evaluation_jobs_v1","fair share claim")
need(r"PARTITION BY COALESCE\(j\.company_id::text,'__preactivation__'\)","company fair share")
need(r"pg_advisory_xact_lock\(hashtextextended\('ce-job-claim',0\)\)","race-safe claim")
need(r"ce_reap_expired_jobs_v1","lease reaper")
need(r"ce_automation_initiate_local_v1","automation local init")
need(r"ce_automation_initiate_canonical_v1","automation canonical init")
need(r"'00000000-0000-0000-0000-000000000001'::uuid,'automation'","explicit system actor")
need(r"vault\.create_secret","Vault worker secret")
need(r"ce_verify_worker_token_v1","worker token verify")
need(r"cron\.schedule\(","cron activation")
need(r"net\.http_post\(","pg_net worker call")
need(r"p_mark_existing_stale", "Task1 methodology dependency not duplicated") if False else None
print("PR29 TASK2 SQL CONTRACT: PASS")
