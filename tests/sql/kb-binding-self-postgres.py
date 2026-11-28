#!/usr/bin/env python3
"""Task3C B: native LOCAL PostgreSQL roles/RLS/CAS/rollback, never Hosted credit.

Runs the repository migrations without weakening their preimage guards. Each run
owns a disposable loopback-only cluster; no external DSN is accepted. Supabase
Auth claims and Vault are explicitly synthetic local fixtures. The fixture Vault
tests transaction behavior, not production encryption or gateway JWT validation.

Usage: C3_PG_BIN=/path/to/postgresql/bin python3 tests/sql/kb-binding-self-postgres.py
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "supabase/migrations/20261111030000_task3c_company_kb_binding.sql"
WRAPPER = ROOT / "supabase/migrations/20261112024210_task3c_kb_binding_authenticated_save.sql"
ROLLBACK = ROOT / "supabase/migrations/rollback/20261112024210_task3c_kb_binding_authenticated_save.rollback.sql"
COMPANY = "bdb07806-be44-499c-bfcb-b08afac2d213"
CHANNEL = "99b7e832-0da8-4a44-8738-2e5fe9cb9685"
ACTOR = "740ec4da-4a09-4395-a362-5b6a52e0dd03"
ADMIN2 = "00000000-0000-4000-8000-000000000102"
AGENT = "00000000-0000-4000-8000-000000000103"
FOREIGN = "00000000-0000-4000-8000-000000000104"
ORPHAN = "00000000-0000-4000-8000-000000000105"
OTHER_COMPANY = "00000000-0000-4000-8000-000000000201"
OTHER_CHANNEL = "00000000-0000-4000-8000-000000000202"
KEY1 = "LOCAL-SYNTHETIC-KEY-ONE-0001"
KEY2 = "LOCAL-SYNTHETIC-KEY-TWO-0002"
SIG = "public.kb_binding_write_self_v1(uuid,text,text,boolean,bigint,text,boolean)"
checks: list[str] = []


def check(name: str, condition: bool) -> None:
    if not condition:
        raise AssertionError(name)
    checks.append(name)


def quoted(value: str | None) -> str:
    return "NULL" if value is None else "'" + value.replace("'", "''") + "'"


def run(args: list[str], *, data: str | None = None, timeout: int = 30):
    # Do not inherit PGHOST/PGSERVICE/PGPASSWORD or any remote connection settings.
    return subprocess.run(args, input=data, capture_output=True, text=True,
                          env=PROCESS_ENV, timeout=timeout)


PROCESS_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
pg_input = os.environ.get("C3_PG_BIN")
if not pg_input:
    raise SystemExit("C3_PG_BIN is required; this test never accepts a database URL")
PG_INPUT = Path(pg_input).resolve()
for binary in ("postgres", "pg_config", "initdb", "pg_ctl", "psql"):
    if not (PG_INPUT / binary).is_file():
        raise SystemExit(f"Missing local PostgreSQL binary: {binary}")

# Relocate a copy of the native runtime so the fixture extension never modifies
# an installed PostgreSQL share directory or a real database server.
paths = run([str(PG_INPUT / "pg_config"), "--bindir", "--sharedir", "--pkglibdir"])
if paths.returncode:
    raise SystemExit(paths.stderr)
bindir, sharedir, libdir = [Path(x) for x in paths.stdout.strip().splitlines()]
prefix = Path(os.path.commonpath([bindir, sharedir, libdir]))
temp = Path(tempfile.mkdtemp(prefix="c3-kb-binding-native-"))
runtime = temp / "runtime"
for source in (bindir, sharedir, libdir):
    shutil.copytree(source, runtime / source.relative_to(prefix), symlinks=True)
PG = runtime / bindir.relative_to(prefix)
SHARE = runtime / sharedir.relative_to(prefix)
DATA = temp / "data"
with socket.socket() as candidate:
    candidate.bind(("127.0.0.1", 0))
    PORT = candidate.getsockname()[1]
psql = [str(PG / "psql"), "-h", "127.0.0.1", "-p", str(PORT), "-d", "postgres",
        "-X", "-qAt", "-v", "ON_ERROR_STOP=1"]


def sql(body: str, *, role: str = "postgres", ok: bool = True):
    result = run(psql + ["-U", role], data=body)
    if ok and result.returncode:
        raise AssertionError(result.stderr)
    return result


def auth(body: str, *, actor: str | None = ACTOR, claim_role: str = "authenticated",
         role: str = "authenticated", ok: bool = True):
    claims = {"role": claim_role}
    if actor is not None:
        claims["sub"] = actor
    return sql("BEGIN;SET LOCAL request.jwt.claims=" + quoted(json.dumps(claims))
               + ";SET LOCAL application_name='kb-binding-native-client';" + body
               + "COMMIT;", role=role, ok=ok)


def call(*, company: str | None = COMPANY, tenant: str | None = "50",
         revision: int | None = 0, key: str | None = None, active: bool | None = True,
         probe: bool | None = False, kb_company: str | None = None) -> str:
    boolean = lambda v: "NULL" if v is None else str(v).lower()
    return ("SELECT public.kb_binding_write_self_v1("
            f"{quoted(company)},{quoted(tenant)},{quoted(kb_company)},"
            f"{boolean(active)},{'NULL' if revision is None else revision},"
            f"{quoted(key)},{boolean(probe)});")


def snapshot() -> str:
    # All fixture keys are synthetic. Return only a digest, never key bytes.
    return sql("SELECT md5(jsonb_build_object('binding',"
               "(SELECT jsonb_agg(to_jsonb(b) ORDER BY company_id) FROM company_kb_tenant_binding b),"
               "'vault',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM vault.secrets s))::text);").stdout.strip()


def denied(name: str, query: str, expected: str, **kwargs) -> None:
    before = snapshot()
    result = auth(query, ok=False, **kwargs)
    check(name, result.returncode != 0 and expected in result.stderr and before == snapshot())


def race(revision: int, winner_key: str, loser_key: str) -> dict:
    """Hold writer one's transaction; prove writer two really waits on its lock."""
    claims = quoted(json.dumps({"sub": ACTOR, "role": "authenticated"}))
    writer = subprocess.Popen(psql + ["-U", "authenticated"], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, env=PROCESS_ENV)
    assert writer.stdin and writer.stdout and writer.stderr
    try:
        writer.stdin.write("BEGIN;SET LOCAL request.jwt.claims=" + claims + ";"
                           + call(revision=revision, key=winner_key)
                           + "SELECT 'FIRST_WRITER_HOLDS_LOCK';\n")
        writer.stdin.flush()
        first = json.loads(writer.stdout.readline())
        check(f"CAS revision {revision}: first real writer holds uncommitted result",
              writer.stdout.readline().strip() == "FIRST_WRITER_HOLDS_LOCK")
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(auth, "SET LOCAL application_name='kb-binding-native-contender';"
                                 + call(revision=revision, key=loser_key), ok=False)
            blocked = False
            for _ in range(150):
                state = sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l "
                            "ON a.pid=l.pid WHERE a.application_name='kb-binding-native-contender' "
                            "AND l.locktype='advisory' AND NOT l.granted);").stdout.strip()
                if state == "t":
                    blocked = True
                    break
                time.sleep(0.01)
            check(f"CAS revision {revision}: second simultaneous DB connection waits on advisory lock", blocked)
            writer.stdin.write("COMMIT;\n")
            writer.stdin.close()
            writer.wait(timeout=10)
            second = future.result(timeout=10)
        check(f"CAS revision {revision}: exactly one commit and one stale-revision rejection",
              writer.returncode == 0 and second.returncode != 0
              and "KB_BINDING_REVISION_CONFLICT" in second.stderr
              and first["revision"] == revision + 1)
        check(f"CAS revision {revision}: loser leaves no key rotation or orphan secret",
              sql("SELECT (SELECT revision FROM company_kb_tenant_binding)=" + str(revision + 1)
                  + " AND (SELECT count(*) FROM vault.secrets)=1 AND "
                  "(SELECT secret FROM vault.secrets)=" + quoted(winner_key) + ";").stdout.strip() == "t")
        return first
    finally:
        if writer.poll() is None:
            writer.kill()
            writer.wait(timeout=10)


fixture_control = SHARE / "extension/supabase_vault.control"
fixture_sql = SHARE / "extension/supabase_vault--0.0-local-test.sql"
fixture_control.write_text("comment = 'SYNTHETIC LOCAL TEST FIXTURE; no encryption claim'\n"
                           "default_version = '0.0-local-test'\nrelocatable = false\n")
fixture_sql.write_text("""
CREATE SCHEMA vault;
REVOKE ALL ON SCHEMA vault FROM PUBLIC;
CREATE TABLE vault.secrets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),secret text NOT NULL,name text,description text);
CREATE VIEW vault.decrypted_secrets AS SELECT id,secret AS decrypted_secret FROM vault.secrets;
CREATE FUNCTION vault.create_secret(p_secret text,p_name text,p_description text) RETURNS uuid
LANGUAGE plpgsql AS $$DECLARE v_id uuid;BEGIN
INSERT INTO vault.secrets(secret,name,description) VALUES(p_secret,p_name,p_description) RETURNING id INTO v_id;
RETURN v_id;END$$;
CREATE FUNCTION vault.update_secret(p_id uuid,p_secret text,p_name text,p_description text,p_key uuid)
RETURNS void LANGUAGE plpgsql AS $$BEGIN
UPDATE vault.secrets SET secret=p_secret WHERE id=p_id;
IF NOT FOUND THEN RAISE EXCEPTION 'LOCAL_VAULT_SECRET_MISSING';END IF;END$$;
REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA vault FROM PUBLIC;
""")
started = False
try:
    initialized = run([str(PG / "initdb"), "-D", str(DATA), "-L", str(SHARE),
                       "-A", "trust", "-U", "postgres", "--no-locale"])
    if initialized.returncode:
        raise AssertionError(initialized.stderr)
    launched = run([str(PG / "pg_ctl"), "-D", str(DATA), "-l", str(temp / "server.log"),
                    "-o", f"-F -h 127.0.0.1 -p {PORT} -c unix_socket_directories=''", "-w", "start"])
    if launched.returncode:
        raise AssertionError(launched.stderr + (temp / "server.log").read_text())
    started = True
    sql(f"""
CREATE ROLE authenticated LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE anon LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT COALESCE(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb,'{{}}'::jsonb)$$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT (auth.jwt()->>'sub')::uuid$$;
GRANT USAGE ON SCHEMA auth TO authenticated,anon;
CREATE TYPE public.app_role AS ENUM('admin','supervisor','agent','qa');
CREATE TABLE company(id uuid PRIMARY KEY,is_active boolean NOT NULL);
CREATE TABLE user_roles(user_id uuid PRIMARY KEY REFERENCES auth.users(id),role app_role NOT NULL);
CREATE TABLE company_membership(user_id uuid,company_id uuid,role app_role,is_active boolean,
 UNIQUE(company_id,user_id,role));
CREATE TABLE channel_config(id uuid PRIMARY KEY,company_id uuid,channel_type text,is_active boolean);
INSERT INTO auth.users VALUES('{ACTOR}'),('{ADMIN2}'),('{AGENT}'),('{FOREIGN}'),('{ORPHAN}');
INSERT INTO company VALUES('{COMPANY}',true),('{OTHER_COMPANY}',true);
INSERT INTO user_roles VALUES('{ACTOR}','admin'),('{ADMIN2}','admin'),('{AGENT}','agent'),
 ('{FOREIGN}','admin'),('{ORPHAN}','admin');
INSERT INTO company_membership VALUES('{ACTOR}','{COMPANY}','admin',true),
 ('{ADMIN2}','{COMPANY}','admin',true),('{AGENT}','{COMPANY}','agent',true),
 ('{FOREIGN}','{OTHER_COMPANY}','admin',true);
INSERT INTO channel_config VALUES('{CHANNEL}','{COMPANY}','web_widget',true),
 ('{OTHER_CHANNEL}','{COMPANY}','web_widget',true);
GRANT SELECT ON company,company_membership,user_roles,channel_config TO authenticated;
ALTER TABLE company_membership ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_membership ON company_membership FOR SELECT TO authenticated USING(user_id=auth.uid());
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_role ON user_roles FOR SELECT TO authenticated USING(user_id=auth.uid());
ALTER TABLE company ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_company ON company FOR SELECT TO authenticated USING(EXISTS(
 SELECT 1 FROM company_membership cm WHERE cm.company_id=company.id AND cm.user_id=auth.uid() AND cm.is_active));
ALTER TABLE channel_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_channel ON channel_config FOR SELECT TO authenticated USING(EXISTS(
 SELECT 1 FROM company_membership cm WHERE cm.company_id=channel_config.company_id AND cm.user_id=auth.uid() AND cm.is_active));
CREATE EXTENSION supabase_vault;
""")
    sql(BASE.read_text())
    inner_before = sql("SELECT md5(pg_get_functiondef('public.kb_binding_write_v1(uuid,uuid,text,text,boolean,bigint,text)'::regprocedure));").stdout.strip()
    check("unchanged original inner writer matches deployed B preimage guard", inner_before == "9a3ef696f9316d6aa6883122e17c4530")
    sql(WRAPPER.read_text())
    check("real authenticated database login is neither superuser nor BYPASSRLS",
          auth("SELECT current_user='authenticated' AND session_user='authenticated' AND NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user;").stdout.strip() == "t")
    check("database is loopback-only isolated local cluster", sql("SHOW listen_addresses;").stdout.strip() == "127.0.0.1")
    check("deployed wrapper has fixed empty search_path and SECURITY DEFINER",
          sql(f"SELECT prosecdef AND proconfig=ARRAY['search_path=\"\"'] FROM pg_proc WHERE oid='{SIG}'::regprocedure;").stdout.strip() == "t")
    check("PUBLIC and anon cannot execute wrapper",
          sql(f"SELECT NOT has_function_privilege('anon','{SIG}','EXECUTE') AND NOT EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(p.proacl) a WHERE p.oid='{SIG}'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE');").stdout.strip() == "t")
    denied("anonymous real database role cannot call privileged wrapper", call(), "permission denied", role="anon", claim_role="anon")
    denied("authenticated role without auth.uid is rejected", call(), "KB_BINDING_SELF_AUTH_REQUIRED", actor=None)
    denied("JWT role mismatch is rejected despite authenticated database role", call(), "KB_BINDING_SELF_AUTH_REQUIRED", claim_role="anon")
    for label, actor in (("non-admin", AGENT), ("foreign-Company Admin", FOREIGN), ("unbound canonical Admin", ORPHAN)):
        denied(label + " cannot write KB50", call(key=KEY1), "KB_BINDING_SELF_SCOPE_DENIED", actor=actor)
    for label, options in (("foreign Company", {"company":OTHER_COMPANY}), ("null Company", {"company":None}),
                           ("foreign KB tenant", {"tenant":"34"}), ("null tenant", {"tenant":None}),
                           ("negative revision", {"revision":-1}), ("null revision", {"revision":None}),
                           ("null active", {"active":None}), ("null probe", {"probe":None})):
        denied(label + " is denied without any persistent change", call(**options), "KB_BINDING_SELF_SCOPE_DENIED")
    for label, mutation, restore in (
        ("inactive membership", f"UPDATE company_membership SET is_active=false WHERE user_id='{ACTOR}';", f"UPDATE company_membership SET is_active=true WHERE user_id='{ACTOR}';"),
        ("canonical role mismatch", f"UPDATE user_roles SET role='agent' WHERE user_id='{ACTOR}';", f"UPDATE user_roles SET role='admin' WHERE user_id='{ACTOR}';"),
        ("inactive Company", f"UPDATE company SET is_active=false WHERE id='{COMPANY}';", f"UPDATE company SET is_active=true WHERE id='{COMPANY}';"),
        ("inactive exact Channel despite another active channel", f"UPDATE channel_config SET is_active=false WHERE id='{CHANNEL}';", f"UPDATE channel_config SET is_active=true WHERE id='{CHANNEL}';"),
        ("wrong exact Channel type", f"UPDATE channel_config SET channel_type='email' WHERE id='{CHANNEL}';", f"UPDATE channel_config SET channel_type='web_widget' WHERE id='{CHANNEL}';"),
        ("exact Channel moved to foreign Company", f"UPDATE channel_config SET company_id='{OTHER_COMPANY}' WHERE id='{CHANNEL}';", f"UPDATE channel_config SET company_id='{COMPANY}' WHERE id='{CHANNEL}';"),
    ):
        sql(mutation)
        denied(label + " blocks Save", call(key=KEY1), "KB_BINDING_SELF_SCOPE_DENIED")
        sql(restore)
    before = snapshot()
    probe = json.loads(auth(call(active=False, probe=True)).stdout)
    check("eligible probe derives real actor and never claims saved", probe == {
        "contract":"kb-binding-self-v1", "eligible":True, "company_id":COMPANY, "actor_id":ACTOR, "saved":False})
    check("eligible probe causes no binding, Vault or audit mutation", before == snapshot())
    for label, options in (("key", {"key":KEY1}), ("KB Company", {"kb_company":"50"}),
                           ("activation", {"active":True}), ("revision", {"revision":1})):
        opts = {"active":False,"probe":True};opts.update(options)
        denied("probe carrying " + label + " is rejected", call(**opts), "KB_BINDING_SELF_INVALID_PROBE")
    denied("activation without key cannot create an active row", call(), "KB_BINDING_KEY_REQUIRED")
    denied("malformed key cannot write", call(key="short"), "KB_BINDING_INVALID_KEY_FORMAT")
    sql("CREATE FUNCTION public.kb_local_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'KB_LOCAL_INSERT_FAULT';END$$;CREATE TRIGGER kb_local_insert_fault BEFORE INSERT ON company_kb_tenant_binding FOR EACH ROW EXECUTE FUNCTION kb_local_fail_insert();")
    denied("fault after synthetic Vault create rolls back new secret and binding atomically", call(key=KEY1), "KB_LOCAL_INSERT_FAULT")
    sql("DROP TRIGGER kb_local_insert_fault ON company_kb_tenant_binding;DROP FUNCTION kb_local_fail_insert();")
    saved = race(0, KEY1, KEY2)
    check("actual successful Save returns only safe committed metadata", saved == {
        "company_id":COMPANY,"kb_tenant_id":"50","kb_company_id":None,"is_active":True,"revision":1,"has_key":True})
    readback = json.loads(auth("SELECT jsonb_build_object('company_id',company_id,'kb_tenant_id',kb_tenant_id,'is_active',is_active,'revision',revision,'updated_by',updated_by) FROM company_kb_tenant_binding;").stdout)
    check("same-Tenant real RLS readback matches committed actor and revision", readback == {
        "company_id":COMPANY,"kb_tenant_id":"50","is_active":True,"revision":1,"updated_by":ACTOR})
    check("another legitimate Admin of same Company can read mapping", auth("SELECT count(company_id) FROM company_kb_tenant_binding;",actor=ADMIN2).stdout.strip() == "1")
    for label, actor in (("foreign Admin",FOREIGN),("same-Company agent",AGENT),("unbound Admin",ORPHAN)):
        check(label + " receives zero rows through real RLS", auth("SELECT count(company_id) FROM company_kb_tenant_binding;",actor=actor).stdout.strip() == "0")
    denied("raw secret reference is not selectable by authenticated", "SELECT api_key_secret_ref FROM company_kb_tenant_binding;", "permission denied")
    denied("direct Vault plaintext read denied", "SELECT secret FROM vault.secrets;", "permission denied")
    denied("authenticated cannot invoke original caller-supplied actor writer", f"SELECT kb_binding_write_v1('{ACTOR}','{COMPANY}','50',NULL,true,1,NULL);", "permission denied")
    denied("authenticated cannot invoke privileged secret resolver", f"SELECT kb_binding_secret_v1('{COMPANY}','50');", "permission denied")
    denied("authenticated cannot bypass CAS with direct UPDATE", "UPDATE company_kb_tenant_binding SET revision=9;", "permission denied")
    denied("authenticated cannot delete binding directly", "DELETE FROM company_kb_tenant_binding;", "permission denied")
    denied("stale Save leaves row, audit and key unchanged", call(revision=0,key=KEY2), "KB_BINDING_REVISION_CONFLICT")
    sql("CREATE FUNCTION public.kb_local_wrong_postimage() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.revision:=NEW.revision+7;RETURN NEW;END$$;CREATE TRIGGER kb_local_postimage_fault BEFORE UPDATE ON company_kb_tenant_binding FOR EACH ROW EXECUTE FUNCTION kb_local_wrong_postimage();")
    denied("postimage mismatch rolls back existing key rotation, row revision and audit together", call(revision=1,key=KEY2), "KB_BINDING_SELF_POSTIMAGE_MISMATCH")
    sql("DROP TRIGGER kb_local_postimage_fault ON company_kb_tenant_binding;DROP FUNCTION kb_local_wrong_postimage();")
    race(1, KEY2, KEY1)
    check("successful replacement preserves one key reference and one chronological audit event",
          sql("SELECT revision=2 AND jsonb_array_length(audit_history)=1 AND audit_history->0->>'revision'='1' AND (audit_history->0->>'key_rotated')::boolean FROM company_kb_tenant_binding;").stdout.strip() == "t")
    updated = json.loads(auth(call(revision=2,key=None),actor=ADMIN2).stdout)
    check("second same-Company Admin can save without an actor allowlist and retain existing key", updated["revision"] == 3 and updated["has_key"] is True
          and sql(f"SELECT updated_by='{ADMIN2}' AND revision=3 FROM company_kb_tenant_binding;").stdout.strip() == "t")
    before = snapshot()
    sql(ROLLBACK.read_text())
    check("original B rollback removes wrapper and preserves committed binding, Vault and audit", before == snapshot()
          and sql(f"SELECT to_regprocedure('{SIG}') IS NULL;").stdout.strip() == "t")
    check("rollback preserves original inner writer definition and privilege boundary", inner_before == sql("SELECT md5(pg_get_functiondef('public.kb_binding_write_v1(uuid,uuid,text,text,boolean,bigint,text)'::regprocedure));").stdout.strip()
          and not auth(f"SELECT kb_binding_write_v1('{ACTOR}','{COMPANY}','50',NULL,true,3,NULL);",ok=False).returncode == 0)
    check("same-Tenant safe RLS readback remains available after privileged entry withdrawal", auth("SELECT revision FROM company_kb_tenant_binding;").stdout.strip() == "3")
    print(json.dumps({"scope":"LOCAL_NATIVE_POSTGRESQL_ONLY", "hosted_credit":False,
                      "vault":"SYNTHETIC_LOCAL_TRANSACTION_FIXTURE_NOT_ENCRYPTION_VALIDATION",
                      "jwt":"LOCAL_CLAIMS_FIXTURE_NOT_GATEWAY_VALIDATION",
                      "postgres":sql("SHOW server_version;").stdout.strip(),
                      "source_sha256":{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (BASE,WRAPPER,ROLLBACK)},
                      "assertions":checks,"count":len(checks),"result":"PASS"},indent=2))
finally:
    if started:
        run([str(PG / "pg_ctl"),"-D",str(DATA),"-m","immediate","-w","stop"])
    shutil.rmtree(temp)
