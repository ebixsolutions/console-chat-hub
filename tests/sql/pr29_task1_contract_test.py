#!/usr/bin/env python3
from pathlib import Path
import re, sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
sql = (root / "sql/pr29/pr29_ce_evaluation_freshness_queue.sql").read_text()
rb = (root / "sql/pr29/pr29_ce_evaluation_freshness_queue.rollback.sql").read_text()

def need(pattern: str, label: str, flags=0):
    if not re.search(pattern, sql, flags):
        raise SystemExit(f"FAIL missing: {label}")
    print(f"PASS {label}")

need(r"CREATE TABLE IF NOT EXISTS public\.ce_evaluation_methodology", "methodology single source")
need(r"evaluation_fingerprint.*CHECK \(evaluation_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)", "fingerprint shape", re.S)
need(r"extensions\.digest\(", "SHA256 digest")
need(r"p_contract_version \|\| '\|' \|\|\s*p_prompt_hash \|\| '\|' \|\|\s*p_scoring_config_hash \|\| '\|' \|\|\s*p_evaluator_schema_hash", "composite fingerprint inputs", re.S)
need(r"p_mark_existing_stale boolean DEFAULT false", "no automatic backfill default")
need(r"CREATE TABLE IF NOT EXISTS public\.ce_evaluation_state", "freshness state")
need(r"'never_evaluated'.*'up_to_date'.*'dirty'.*'queued'.*'evaluating'.*'failed'.*'stale_version'", "state machine", re.S)
need(r"revision bigint NOT NULL DEFAULT 0", "monotonic revision")
need(r"CREATE TABLE IF NOT EXISTS public\.ce_evaluation_job", "evaluation queue")
need(r"UNIQUE \(conversation_id, snapshot_hash, evaluation_fingerprint\)", "idempotent composite unique")
need(r"p_conversation_id::text \|\| '\|' \|\|\s*p_snapshot_hash \|\| '\|' \|\|\s*p_evaluation_fingerprint", "job key inputs", re.S)
need(r"source text NOT NULL CHECK \(source IN \(", "queue source allowlist")
need(r"'scheduler'.*'ce_dwell'.*'resolved'.*'verified_correction'.*'manual'.*'max_age'", "all queue trigger sources", re.S)
need(r"AFTER INSERT OR DELETE OR UPDATE OF\s+conversation_id,\s+content,\s+role,\s+is_recalled,\s+sender_id,\s+sender_identity_verified_at", "message change explicit allowlist", re.S)
if "metadata," in re.search(r"AFTER INSERT OR DELETE OR UPDATE OF(.*?)ON public\.messages", sql, re.S).group(1):
    raise SystemExit("FAIL metadata must not trigger evaluation")
print("PASS non-evaluation metadata excluded")
need(r"freshness IN \('current','superseded'\)", "current/superseded audit freshness")
need(r"v_is_current := v_state\.revision = p_expected_revision", "race comparison")
need(r"'result','superseded'", "superseded completion path")
need(r"state = 'dirty'", "superseded leaves latest state dirty")
need(r"REVOKE ALL ON public\.ce_evaluation_job FROM PUBLIC, anon, authenticated", "queue service-only")
need(r"company_id = ce_evaluation_state\.company_id.*cm\.user_id = auth\.uid\(\).*cm\.is_active = true", "state tenant read guard", re.S)
need(r"ON CONFLICT \(conversation_id\) DO NOTHING", "bootstrap idempotency")
if "INSERT INTO public.ce_evaluation_job" in sql.split("-- 10. One-time state bootstrap")[1]:
    raise SystemExit("FAIL bootstrap must not enqueue jobs")
print("PASS bootstrap does not enqueue or call LLM")

for obj in [
    "trg_ce_message_evaluation_dirty",
    "ce_finalize_evaluation_freshness_v1",
    "ce_enqueue_evaluation_v1",
    "ce_evaluation_job",
    "ce_evaluation_state",
    "ce_evaluation_methodology",
]:
    if obj not in rb:
        raise SystemExit(f"FAIL rollback missing {obj}")
print("PASS rollback coverage")

for forbidden in ["GOOGLE_SERVICE_ACCOUNT_JSON", "ANTHROPIC_API_KEY", "KB_RAG_TOKEN", "service_role_key"]:
    if forbidden in sql or forbidden in rb:
        raise SystemExit(f"FAIL secret reference in SQL: {forbidden}")
print("PASS no secret material")

print("PR29 TASK1 CONTRACT TEST: PASS")
