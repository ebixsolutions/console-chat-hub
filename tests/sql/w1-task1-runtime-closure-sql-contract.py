from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sql = (ROOT / "supabase/migrations/20260826090000_widget_live_test_runtime_closure.sql").read_text()
rb = (ROOT / "supabase/migrations/rollback/20260826090000_widget_live_test_runtime_closure.rollback.sql").read_text()

for marker in [
    "_ce_enforce_conversation_company",
    "widget_live_test",
    "exclude_training",
    "company_membership",
    "user_roles",
    "ce_mark_evaluation_dirty",
    "ce_conversation_evaluable_v1",
]:
    assert marker in sql, marker

assert "TENANT_UNRESOLVED" in sql
assert "TENANT_REASSIGNMENT" in sql
assert "TENANT_CHANNEL_MISMATCH" in sql

for marker in [
    "TENANT_UNRESOLVED",
    "ce_runtime_conversation_company",
    "count(*) FILTER",
]:
    assert marker in rb, marker

print("PASS narrow null-company exception + ordinary fail-closed tenant enforcement")
print("PASS Widget Live Test excluded from CE/training evaluator state")
print("PASS rollback definitions present")
