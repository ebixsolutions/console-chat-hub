# SAME C3 / PR12 F06 conditional candidate

Director authorization: 2026-10-06 attachment sections 3–5. Production nrfx remains the only application backend. This directory contains disposable verification SQL, not live execution receipts. Migration is conditional; never deploy from a test PASS alone.

Native PostgreSQL 16.15 CI run 37430866457 on source f61508fcdcc89474269789708cd385a9d73d1ec3 passed. Artifact 11396274276 ZIP SHA256 9cd2d1e5b0c46acd2e7a28593516ee476c0b94977060eb16fd752dd4a72b30ad. Independently observed PID waits prove same-request/payload races and fresh control-state reads. Actual SET ROLE ACL checks and receipt/hash/dependency guarded rollback were executed. Isolated baseline is a schema subset; current production triggers/constraints still require live readback before deployment.

SQL proposal SHA256 5f34ed2f24a520ed8a2d66f1893f3cf638a5dfd4f1229dc7d36af4946f814493; unchanged behavior. Migration changes its introductory authorization comments only. Old four-parameter function remains unchanged (MD5 2491450055223f90ff932b0faf64c560). Complete entrypoint retains legacy envelope: absent operation UUID generates one server UUID and uses five parameters; it cannot guarantee cross-HTTP exactly-once for legacy callers. New UI retains stable UUID through retries. Direct import closure remains ../_shared/agent.ts and ../_shared/cors.ts, then the existing pinned Supabase 2.45.0 import. Preserve captured current JWT/import-map/config and exact Edge bundle at live deployment.

Live changes are blocked until legal hosted normal-role verification and necessary fixture learning/feedback isolation, current trigger/dependency/baseline readback, frozen change manifest and usable rollback all exist. B12/B13 new objects remain unapproved. No deployment, Publish, main merge, production fixture creation or real customer send is performed by this CI workflow. Workflow contains no production credentials, secrets, environment approvals or production transport.

Run on a dedicated empty localhost database named c3_f06_isolated_*:

    python tests/c3-f06/native-race.py --database "$LOCAL_DATABASE_URL"

The test bootstraps the five provided SQL files in order with psql --no-psqlrc --set ON_ERROR_STOP=1; clones an empty candidate database for dependency/hash/empty rollback tests; records actual backend barriers, locks, SQL command exit codes and row counts. CI containers and local test databases are disposable. Do not run against any Supabase URL. No new OS account or paid service is required.

Before any rollback: stop new five-argument traffic, restore only the freshly captured compatible Edge baseline, preserve old four-argument body/signature/default/ACL. Run sql/c3_f06_capture_rollback_identity.sql after authorized SQL application and retain its three hashes. sql/c3_f06_guarded_rollback.sql requires exact current hashes, empty receipts and no external dependency; no CASCADE DROP and no business data deletion. With receipts present retain additive schema and report functional, non-exact rollback.
