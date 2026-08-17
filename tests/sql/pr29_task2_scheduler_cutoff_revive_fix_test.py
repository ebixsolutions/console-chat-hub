#!/usr/bin/env python3
from pathlib import Path
import re, sys

root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
s=(root/"sql/pr29/pr29_task2_scheduler_cutoff_revive_fix.sql").read_text()

def need(p,label,flags=0):
    if not re.search(p,s,flags):
        raise SystemExit(f"FAIL {label}")
    print("PASS",label)

need(r"ADD COLUMN IF NOT EXISTS automation_started_at timestamptz","activation cutoff column")
need(r"COALESCE\(s\.dirty_since,s\.last_activity_at\) >= v_cfg\.automation_started_at","historical backlog exclusion")
need(r"v_cfg\.automation_started_at IS NULL.*activation_cutoff_missing","fail closed without cutoff",re.S)
need(r"v_interactive := p_source IN \(\s*'manual','ce_dwell','resolved','verified_correction'","interactive revive allowlist",re.S)
need(r"v_job\.status IN \('cancelled','failed'\)","terminal job revive")
need(r"attempts = 0","revive resets attempts")
need(r"WHEN v_job\.status = 'succeeded' THEN 'already_succeeded'","succeeded job not revived")
need(r"WHEN v_job\.status = 'running' THEN 'already_running'","running job not revived")
need(r"automation_started_at=COALESCE\(automation_started_at,now\(\)\)","activation horizon preserved")
need(r"last_background_sweep_at=NULL","fresh safe sweep after enable")
need(r"REVOKE ALL ON FUNCTION public\.ce_enqueue_evaluation_v1","enqueue service-role restricted")
need(r"REVOKE ALL ON FUNCTION public\.ce_scheduler_enqueue_due_v1","scheduler service-role restricted")

# Hard regression guard: the cutoff must appear in the scheduler WHERE clause
# before the debounce/max-age predicate.
where_block=re.search(
    r"WHERE s\.state IN \('never_evaluated','dirty','failed','stale_version'\)(.*?)ORDER BY",
    s,
    re.S,
)
if not where_block:
    raise SystemExit("FAIL scheduler WHERE block missing")
block=where_block.group(1)
cutoff="COALESCE(s.dirty_since,s.last_activity_at) >= v_cfg.automation_started_at"
debounce="s.last_activity_at <= now() - make_interval(mins => v_cfg.debounce_minutes)"
if cutoff not in block or debounce not in block or block.index(cutoff) > block.index(debounce):
    raise SystemExit("FAIL scheduler cutoff must precede debounce eligibility")
print("PASS cutoff precedes debounce eligibility")

print("PR29 TASK2 CUTOFF/REVIVE CONTRACT: PASS")
