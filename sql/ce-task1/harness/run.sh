#!/usr/bin/env bash
# ===========================================================================
# CE-P1 Task 1 — disposable PostgreSQL validation harness.
# Executes the real forward migration and rollback against a throwaway
# PostgreSQL 17 cluster. No production access, no network.
#
#   ./sql/ce-task1/harness/run.sh
#
# Every check is an executed SQL assertion (RAISE EXCEPTION on failure) or a
# psql exit status. There is no grep/parse-only PASS and no "|| true".
# ===========================================================================
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQLDIR="$(cd "$HERE/.." && pwd)"
FWD="$SQLDIR/20260805012800_task1_ce_grounding_replay.sql"
RBK="$SQLDIR/20260805012800_task1_ce_grounding_replay_rollback.sql"
RUN="${CE_HARNESS_DIR:-/tmp/ce-harness}"

# PostgreSQL refuses to run as root: drop to a dedicated unprivileged uid.
if [ "$(id -u)" = 0 ]; then
  rm -rf "$RUN"; mkdir -p "$RUN"; chown -R 4242:4242 "$RUN"
  grep -q '^ceharness:' /etc/passwd 2>/dev/null || \
    echo "ceharness:x:4242:4242::$RUN:/bin/bash" >> /etc/passwd
  exec setpriv --reuid=4242 --regid=4242 --clear-groups \
    env CE_HARNESS_DIR="$RUN" HOME="$RUN" USER=ceharness LOGNAME=ceharness \
        PATH="$PATH" bash "${BASH_SOURCE[0]}"
fi

PGDATA="$RUN/pgdata"
SOCK="$RUN/sock"
LOGS="$RUN/logs"
export PGHOST="$SOCK" PGPORT=55432 PGUSER="$(id -un)" PGDATABASE=postgres
unset PGPASSWORD PGSERVICE || true

rm -rf "$PGDATA" "$SOCK" "$LOGS"; mkdir -p "$PGDATA" "$SOCK" "$LOGS"


PASS=0
ok(){ PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
die(){ printf 'FAIL  %s\n' "$1" >&2; exit 1; }

echo "== boot disposable cluster =="
initdb -D "$PGDATA" -U "$PGUSER" --auth=trust >"$LOGS/initdb.log" 2>&1
pg_ctl -D "$PGDATA" -o "-k $SOCK -p $PGPORT -c listen_addresses=''" \
       -l "$LOGS/pg.log" -w start >/dev/null
trap 'pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true' EXIT
ok "disposable PostgreSQL $(psql -Atc 'show server_version') started"

q(){ psql -v ON_ERROR_STOP=1 -Atq -d "$1" -c "$2"; }
f(){ psql -v ON_ERROR_STOP=1 -q -d "$1" -f "$2"; }

newdb(){
  psql -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1"
  f "$1" "$HERE/00_baseline.sql" >/dev/null
  f "$1" "$HERE/10_seed_baseline_data.sql" >/dev/null
}

snapshot(){ # $1=db $2=outfile — full public-schema shape + ACL + RLS + flags
  psql -Atq -d "$1" -f "$HERE/90_snapshot.sql" | sort > "$2"
}

# ---------------------------------------------------------------------------
echo "== S1 forward migration executes =="
newdb ce_fwd
snapshot ce_fwd "$RUN/pre.txt"
f ce_fwd "$FWD" >"$LOGS/s1.log" 2>&1 || die "S1 forward migration failed (see $LOGS/s1.log)"
ok "S1 forward migration applied in a single transaction"

for obj in public.company public.company_member public.ce_replay_bundle \
           public.ce_replay_chunk public.ce_grounding_violation \
           public.ce_evaluation_review public.ce_training_result \
           public.ce_migration_provenance; do
  [ "$(q ce_fwd "SELECT to_regclass('$obj') IS NOT NULL")" = t ] || die "S1 missing $obj"
done
[ "$(q ce_fwd "SELECT count(*) FROM public.ce_conversation_status_v")" != "" ] || die "S1 status view unusable"
[ "$(q ce_fwd "SELECT enabled FROM public.ce_feature_flags WHERE key='ce_grounding_fail_closed_enabled'")" = f ] \
  || die "S1 gate flag must stay disabled"
ok "S1 canonical objects created, gate flag left disabled"

# ---------------------------------------------------------------------------
echo "== S2 idempotent rerun =="
f ce_fwd "$FWD" >"$LOGS/s2.log" 2>&1 || die "S2 rerun failed (see $LOGS/s2.log)"
[ "$(q ce_fwd "SELECT count(*) FROM public.company")" = 1 ] || die "S2 rerun duplicated company"
[ "$(q ce_fwd "SELECT count(*) FROM public.ce_migration_provenance p1
                WHERE EXISTS (SELECT 1 FROM public.ce_migration_provenance p2
                              WHERE p2.object_identity=p1.object_identity
                                AND p2.object_type=p1.object_type AND p2.id<>p1.id)")" = 0 ] \
  || die "S2 duplicate provenance rows"
ok "S2 rerun is a no-op (no duplicate objects, rows or provenance)"

# ---------------------------------------------------------------------------
echo "== S3 former part1/part2 boundary failure injection =="
newdb ce_inject
python3 - "$FWD" "$RUN/inject.sql" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
sql = open(src).read()
marker = "-- 6. Tenant / company membership primitives"
assert marker in sql, "boundary marker not found"
i = sql.index(marker)
open(dst, "w").write(
    sql[:i]
    + "DO $inj$ BEGIN RAISE EXCEPTION 'CE_HARNESS_INJECTED_BOUNDARY_FAILURE'; END $inj$;\n"
    + sql[i:]
)
PY
if f ce_inject "$RUN/inject.sql" >"$LOGS/s3.log" 2>&1; then
  die "S3 injected migration unexpectedly succeeded"
fi
grep -q CE_HARNESS_INJECTED_BOUNDARY_FAILURE "$LOGS/s3.log" || die "S3 wrong failure"
for obj in public.company public.company_member public.ce_replay_bundle \
           public.ce_migration_provenance; do
  [ "$(q ce_inject "SELECT to_regclass('$obj') IS NULL")" = t ] || die "S3 partial state: $obj survived"
done
[ "$(q ce_inject "SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND column_name='company_id'")" = 0 ] \
  || die "S3 partial state: company_id column survived"
ok "S3 failure at the former part1/part2 boundary rolls back to ZERO partial state"

# ---------------------------------------------------------------------------
echo "== S4-S8 RLS/RBAC, grounding, replay, raw-data, retention, immutability =="
newdb ce_rt
f ce_rt "$FWD" >"$LOGS/s4.log" 2>&1 || die "S4 migration failed"
f ce_rt "$HERE/20_tests_runtime.sql" >"$LOGS/s4t.log" 2>&1 || {
  tail -40 "$LOGS/s4t.log" >&2; die "S4-S8 runtime assertions failed (see $LOGS/s4t.log)"; }
N=$(grep -c 'CE_TEST_OK' "$LOGS/s4t.log")
ok "S4-S8 $N executed runtime assertions passed (tenant matrix, cross-tenant denial, grounding, replay + hash mismatch, admin-only raw data, retention purge, immutability, canonical status)"

# ---------------------------------------------------------------------------
echo "== S9 rollback with empty data + exact pre-state restoration =="
newdb ce_rb_empty
snapshot ce_rb_empty "$RUN/pre_empty.txt"
f ce_rb_empty "$FWD" >"$LOGS/s9f.log" 2>&1 || die "S9 migration failed"
f ce_rb_empty "$RBK" >"$LOGS/s9r.log" 2>&1 || die "S9 rollback failed (see $LOGS/s9r.log)"
grep -q CE_ROLLBACK_COMPLETE "$LOGS/s9r.log" || die "S9 rollback did not report completion"
snapshot ce_rb_empty "$RUN/post_empty.txt"
diff -u "$RUN/pre_empty.txt" "$RUN/post_empty.txt" > "$RUN/diff_empty.txt" \
  || { head -60 "$RUN/diff_empty.txt" >&2; die "S9 pre-state NOT restored exactly"; }
ok "S9 empty rollback succeeded and restored the exact pre-migration catalog state"

echo "== S9b rollback idempotency =="
f ce_rb_empty "$RBK" >"$LOGS/s9r2.log" 2>&1 || die "S9b rollback rerun failed"
grep -q CE_ROLLBACK_NOOP "$LOGS/s9r2.log" || die "S9b rollback rerun was not a no-op"
ok "S9b rollback rerun is a no-op"

# ---------------------------------------------------------------------------
echo "== S10 rollback fails closed with production-like data =="
newdb ce_rb_data
f ce_rb_data "$FWD" >"$LOGS/s10f.log" 2>&1 || die "S10 migration failed"
f ce_rb_data "$HERE/30_prodlike_data.sql" >"$LOGS/s10d.log" 2>&1 || die "S10 data load failed"
if f ce_rb_data "$RBK" >"$LOGS/s10r.log" 2>&1; then
  die "S10 rollback destroyed production-like data instead of failing closed"
fi
grep -q CE_ROLLBACK_BLOCKED "$LOGS/s10r.log" || { tail -20 "$LOGS/s10r.log" >&2; die "S10 wrong failure"; }
[ "$(q ce_rb_data "SELECT count(*) FROM public.ce_replay_bundle")" = 1 ] || die "S10 CE data lost"
[ "$(q ce_rb_data "SELECT to_regclass('public.company') IS NOT NULL")" = t ] || die "S10 objects dropped"
[ "$(q ce_rb_data "SELECT count(*) FROM public.conversations")" != 0 ] || die "S10 user data lost"
ok "S10 rollback failed closed (CE_ROLLBACK_BLOCKED), dropped nothing, kept all user data"

# ---------------------------------------------------------------------------
echo
echo "ALL HARNESS CHECKS PASSED ($PASS scenario gates, $N runtime assertions)"
