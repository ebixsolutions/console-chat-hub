#!/usr/bin/env python3
from __future__ import annotations
import json, os, stat, sys, uuid
from pathlib import Path
from urllib.parse import urlparse

EXPECTED_PROJECT_REF = "hvmtoqiwdqvgnjepxwrc"

REQUIRED = ['PR11_FINAL_PRODUCT_READY_INTEGRATION_AUTHORIZED', 'PR7_PRODUCTION_DEPLOY_AUTHORIZED', 'PR7_PROJECT_REF', 'SUPABASE_DB_URL', 'SUPABASE_ACCESS_TOKEN', 'PR11_AUTHORIZED_SOURCE_COMMIT', 'PR7_ROLLBACK_COMMIT', 'PR7_CANONICAL_COMPANY_UUID', 'PR7_CANONICAL_PLATFORM_COMPANY_ID', 'PR7_CANONICAL_COMPANY_SLUG', 'PR7_CANONICAL_COMPANY_NAME', 'PR7_CANONICAL_EXTERNAL_WORKSPACE_ID', 'PR7_CANONICAL_EXTERNAL_TENANT_ID', 'PR7_BOOTSTRAP_RUN_ID', 'PR7_MEMBERSHIP_BOOTSTRAP_RUN_ID', 'PR7_CHANNEL_OWNERSHIP_RUN_ID', 'PR7_CONVERSATION_LINEAGE_RUN_ID', 'PR7_LEGACY_DATA_IS_SINGLE_COMPANY', 'PR7_LEGACY_ORPHAN_CONVERSATIONS_BELONG_TO_CANONICAL_COMPANY', 'PR11_PRIMARY_ACCEPTANCE_USER_UUID', 'ENABLE_KB_ADAPTER', 'ENABLE_CUSTOMER360_ADAPTER', 'ENABLE_COACH_PROMPT_ADAPTER', 'ANTHROPIC_API_KEY', 'KB_SINGAPORE_TENANT_MAP_JSON', 'KB_SINGAPORE_JWT_SECRET', 'CUSTOMER360_INTERNAL_TOKEN', 'CUSTOMER360_API_URL', 'CUSTOMER360_API_TOKEN', 'COACH_PROMPT_ENDPOINT', 'COACH_PROMPT_INTERNAL_TOKEN', 'C360_COACH_SYNC_INTERNAL_TOKEN', 'COACH_C360_SYNC_API_URL', 'COACH_C360_SYNC_API_TOKEN', 'C360_COACH_SYNC_CONTRACT_VERSION', 'CE_CONTRACT_VERSION', 'CE_SOURCE_DEPLOYMENT', 'LLM_MODEL_EVALUATION', 'SU_COACHAI_EVALUATION_ENDPOINT', 'SU_COACHAI_AUTH_HEADER', 'SU_COACHAI_AUTH_VALUE', 'TRAINING_OUTBOX_INTERNAL_TOKEN', 'SU_COACHAI_RESULT_TOKEN', 'PR8_CE_SMOKE_FIXTURE_APPROVED', 'PR8_CE_SMOKE_CONVERSATION_ID', 'PR8_CE_SMOKE_BEARER_TOKEN', 'PR8_CE_HANDOFF_FIXTURE_APPROVED', 'PR8_CE_HANDOFF_EVALUATION_ID', 'PR8_CE_HANDOFF_CONVERSATION_ID', 'PR8_CE_HANDOFF_BEARER_TOKEN', 'PR9_KB_SMOKE_QUERY', 'PR10_TWO_TENANT_FIXTURES_APPROVED', 'PR10_EDGE_API_FIXTURES_APPROVED', 'PR10_MUTATION_FIXTURES_APPROVED', 'PR10_TENANT_A_COMPANY_UUID', 'PR10_TENANT_B_COMPANY_UUID', 'PR10_TENANT_A_USER_UUID', 'PR10_TENANT_B_USER_UUID', 'PR10_TENANT_A_AGENT_PROFILE_UUID', 'PR10_TENANT_B_AGENT_PROFILE_UUID', 'PR10_TENANT_A_CONVERSATION_UUID', 'PR10_TENANT_B_CONVERSATION_UUID', 'PR10_TENANT_A_VISITOR_SESSION_UUID', 'PR10_TENANT_B_VISITOR_SESSION_UUID', 'PR10_TENANT_A_BEARER_TOKEN', 'PR10_TENANT_B_BEARER_TOKEN', 'PR10_KB_TENANT_A_QUERY', 'PR10_KB_TENANT_B_QUERY', 'PR10_KB_TENANT_A_EXPECTED_DOCUMENT_ID', 'PR10_KB_TENANT_B_EXPECTED_DOCUMENT_ID', 'PR7_TEST_USER_A', 'PR7_TEST_COMPANY_A', 'PR7_TEST_USER_B', 'PR7_TEST_COMPANY_B']
OPTIONAL = {"KB_SINGAPORE_JWT_TTL_SEC", "PR7_FUNCTIONS_URL"}
SECRET_KEYS = {
    "SUPABASE_DB_URL","SUPABASE_ACCESS_TOKEN","ANTHROPIC_API_KEY",
    "KB_SINGAPORE_JWT_SECRET","CUSTOMER360_INTERNAL_TOKEN","CUSTOMER360_API_TOKEN",
    "COACH_PROMPT_INTERNAL_TOKEN","C360_COACH_SYNC_INTERNAL_TOKEN",
    "COACH_C360_SYNC_API_TOKEN","SU_COACHAI_AUTH_VALUE","TRAINING_OUTBOX_INTERNAL_TOKEN",
    "SU_COACHAI_RESULT_TOKEN","PR8_CE_SMOKE_BEARER_TOKEN","PR8_CE_HANDOFF_BEARER_TOKEN",
    "PR10_TENANT_A_BEARER_TOKEN","PR10_TENANT_B_BEARER_TOKEN",
}

UUID_KEYS = {
    "PR7_CANONICAL_COMPANY_UUID","PR7_BOOTSTRAP_RUN_ID",
    "PR7_MEMBERSHIP_BOOTSTRAP_RUN_ID","PR7_CHANNEL_OWNERSHIP_RUN_ID",
    "PR7_CONVERSATION_LINEAGE_RUN_ID","PR11_PRIMARY_ACCEPTANCE_USER_UUID",
    "PR8_CE_SMOKE_CONVERSATION_ID","PR8_CE_HANDOFF_EVALUATION_ID",
    "PR8_CE_HANDOFF_CONVERSATION_ID","PR10_TENANT_A_COMPANY_UUID",
    "PR10_TENANT_B_COMPANY_UUID","PR10_TENANT_A_USER_UUID",
    "PR10_TENANT_B_USER_UUID","PR10_TENANT_A_AGENT_PROFILE_UUID",
    "PR10_TENANT_B_AGENT_PROFILE_UUID","PR10_TENANT_A_CONVERSATION_UUID",
    "PR10_TENANT_B_CONVERSATION_UUID","PR10_TENANT_A_VISITOR_SESSION_UUID",
    "PR10_TENANT_B_VISITOR_SESSION_UUID","PR7_TEST_USER_A","PR7_TEST_COMPANY_A",
    "PR7_TEST_USER_B","PR7_TEST_COMPANY_B",
}

YES_KEYS = {
    "PR11_FINAL_PRODUCT_READY_INTEGRATION_AUTHORIZED",
    "PR7_PRODUCTION_DEPLOY_AUTHORIZED",
    "PR7_LEGACY_DATA_IS_SINGLE_COMPANY",
    "PR7_LEGACY_ORPHAN_CONVERSATIONS_BELONG_TO_CANONICAL_COMPANY",
    "PR8_CE_SMOKE_FIXTURE_APPROVED","PR8_CE_HANDOFF_FIXTURE_APPROVED",
    "PR10_TWO_TENANT_FIXTURES_APPROVED","PR10_EDGE_API_FIXTURES_APPROVED",
    "PR10_MUTATION_FIXTURES_APPROVED",
}
TRUE_KEYS = {"ENABLE_KB_ADAPTER","ENABLE_CUSTOMER360_ADAPTER","ENABLE_COACH_PROMPT_ADAPTER"}
HTTPS_KEYS = {"CUSTOMER360_API_URL","COACH_PROMPT_ENDPOINT","COACH_C360_SYNC_API_URL"}

def die(msg: str, rc: int = 2) -> None:
    print("STOP: " + msg)
    raise SystemExit(rc)

def parse_uuid(name: str, value: str) -> str:
    try:
        canonical = str(uuid.UUID(value))
    except Exception:
        die(f"{name} invalid UUID", 1)
    if canonical != value.lower():
        die(f"{name} must use canonical lowercase UUID form", 1)
    return canonical

def main() -> None:
    if len(sys.argv) != 2:
        die("usage: pr12-product-ready-activation-loader.py /absolute/path/to/private-activation.json")
    path = Path(sys.argv[1]).expanduser()
    if not path.is_absolute():
        die("activation JSON path must be absolute")
    if not path.is_file():
        die("activation JSON not found")

    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        die("activation JSON permissions too broad; require chmod 600")

    repo = Path(os.environ.get("PR11_REPO", str(Path.home()/ "Documents/GitHub/console-chat-hub"))).resolve()
    try:
        path.resolve().relative_to(repo)
        die("activation JSON must live OUTSIDE the Git repository")
    except ValueError:
        pass

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        die("activation JSON invalid")
    if not isinstance(raw, dict):
        die("activation JSON must be an object")

    unknown = set(raw) - set(REQUIRED) - OPTIONAL
    if unknown:
        die("activation JSON contains unknown keys: " + ",".join(sorted(unknown)), 1)

    missing = [k for k in REQUIRED if not isinstance(raw.get(k), str) or not raw[k].strip()]
    if missing:
        die("required activation values missing: " + ",".join(missing))

    values = {k: v.strip() if isinstance(v, str) else v for k,v in raw.items()}

    for k in YES_KEYS:
        if values[k] != "YES": die(f"{k} must equal YES", 1)
    for k in TRUE_KEYS:
        if values[k] != "true": die(f"{k} must equal true", 1)

    if values["PR7_PROJECT_REF"] != EXPECTED_PROJECT_REF:
        die("PR7_PROJECT_REF mismatch", 1)

    for k in UUID_KEYS:
        values[k] = parse_uuid(k, values[k])

    if not values["PR7_CANONICAL_PLATFORM_COMPANY_ID"].isdigit() or int(values["PR7_CANONICAL_PLATFORM_COMPANY_ID"]) <= 0:
        die("PR7_CANONICAL_PLATFORM_COMPANY_ID must be positive integer", 1)

    for k in ("PR11_AUTHORIZED_SOURCE_COMMIT","PR7_ROLLBACK_COMMIT"):
        v=values[k].lower()
        if len(v)!=40 or any(c not in "0123456789abcdef" for c in v):
            die(f"{k} must be exact 40-char Git SHA", 1)
        values[k]=v
    if values["PR11_AUTHORIZED_SOURCE_COMMIT"] == values["PR7_ROLLBACK_COMMIT"]:
        die("rollback commit must differ from authorized source commit", 1)

    for k in HTTPS_KEYS:
        u=urlparse(values[k])
        if u.scheme != "https" or not u.netloc:
            die(f"{k} must be absolute https URL", 1)

    for k,minlen in {
        "ANTHROPIC_API_KEY":20,"KB_SINGAPORE_JWT_SECRET":32,
        "CUSTOMER360_INTERNAL_TOKEN":24,"CUSTOMER360_API_TOKEN":16,
        "COACH_PROMPT_INTERNAL_TOKEN":24,"C360_COACH_SYNC_INTERNAL_TOKEN":24,
        "COACH_C360_SYNC_API_TOKEN":16,"SU_COACHAI_AUTH_VALUE":16,
        "TRAINING_OUTBOX_INTERNAL_TOKEN":24,"SU_COACHAI_RESULT_TOKEN":24,
    }.items():
        if len(values[k]) < minlen: die(f"{k} too short", 1)

    # One canonical fixture set for legacy PR7 RLS and PR10 runtime.
    pairs = [
        ("PR7_TEST_USER_A","PR10_TENANT_A_USER_UUID"),
        ("PR7_TEST_COMPANY_A","PR10_TENANT_A_COMPANY_UUID"),
        ("PR7_TEST_USER_B","PR10_TENANT_B_USER_UUID"),
        ("PR7_TEST_COMPANY_B","PR10_TENANT_B_COMPANY_UUID"),
    ]
    for old,new in pairs:
        if values[old] != values[new]:
            die(f"{old} must exactly equal {new}", 1)
    if values["PR10_TENANT_A_COMPANY_UUID"] == values["PR10_TENANT_B_COMPANY_UUID"]:
        die("two-tenant company fixtures must differ", 1)
    if values["PR10_TENANT_A_USER_UUID"] == values["PR10_TENANT_B_USER_UUID"]:
        die("two-tenant user fixtures must differ", 1)

    try:
        mapping=json.loads(values["KB_SINGAPORE_TENANT_MAP_JSON"])
    except Exception:
        die("KB_SINGAPORE_TENANT_MAP_JSON invalid JSON", 1)
    if not isinstance(mapping, dict) or not mapping:
        die("KB_SINGAPORE_TENANT_MAP_JSON must be non-empty object", 1)
    norm={}
    reverse={}
    for k,v in mapping.items():
        nk=parse_uuid("KB_SINGAPORE_TENANT_MAP_JSON key", str(k))
        if not isinstance(v,str) or not v.strip():
            die("Singapore tenant id must be non-empty", 1)
        tv=v.strip()
        if tv in reverse and reverse[tv] != nk:
            die("Singapore tenant id collision across AI companies", 1)
        norm[nk]=tv; reverse[tv]=nk
    for ck in ("PR7_CANONICAL_COMPANY_UUID","PR10_TENANT_A_COMPANY_UUID","PR10_TENANT_B_COMPANY_UUID"):
        if values[ck] not in norm:
            die(f"{ck} missing explicit Singapore tenant mapping", 1)
    if norm[values["PR10_TENANT_A_COMPANY_UUID"]] == norm[values["PR10_TENANT_B_COMPANY_UUID"]]:
        die("PR10 Tenant A/B map to same Singapore tenant", 1)

    ttl=values.get("KB_SINGAPORE_JWT_TTL_SEC","300")
    try: n=int(ttl)
    except Exception: die("KB_SINGAPORE_JWT_TTL_SEC invalid", 1)
    if not 60 <= n <= 900: die("KB_SINGAPORE_JWT_TTL_SEC must be 60..900", 1)
    values["KB_SINGAPORE_JWT_TTL_SEC"]=str(n)

    # Never print any value. Only names and validation result.
    print(f"PASS activation parameter contract: {len(REQUIRED)} required values")
    print("PASS private activation file outside repo with mode 600")
    print("PASS canonical identity / source lock / rollback syntax")
    print("PASS PR7/PR10 two-tenant fixture aliases are identical")
    print("PASS Singapore canonical + two-tenant mappings are explicit/distinct")

    env=os.environ.copy()
    env.update({k:str(v) for k,v in values.items() if isinstance(v,str) and v != ""})
    runner=repo/"scripts/pr11-final-product-ready-integration-runner.sh"
    if not runner.is_file():
        die("final integration runner missing")
    os.chdir(repo)
    os.execvpe("bash", ["bash", str(runner)], env)

if __name__ == "__main__":
    main()
