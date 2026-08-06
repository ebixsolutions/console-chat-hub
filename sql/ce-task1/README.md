# CE Task 1 — Staged SQL migration and test harness

## Relationship to supabase/migrations/

- `supabase/migrations/20260728093000_ce_task1.sql` is the DEPLOYMENT artifact
  (the file that will be applied to the live Supabase database via the
  platform migration tool).

- `sql/ce-task1/20260805012800_task1_ce_grounding_replay.sql` is the
  DEVELOPMENT artifact validated on a disposable PostgreSQL 17.9 cluster.
  It was authored in the Lovable Chat session and frozen after passing all
  9 scenario gates and 25 runtime assertions.

- Both files implement the same schema surface. The deployment artifact
  (`supabase/migrations/`) uses the `_ce_ledger` provenance approach;
  the development artifact (`sql/ce-task1/`) uses `ce_migration_provenance`.

## Harness

`sql/ce-task1/harness/run.sh` executes the full validation cycle:
  1. Forward migration
  2. Idempotent rerun
  3. Failure injection at the former part1/part2 boundary
  4. 25 runtime assertions (tenant, grounding, replay, RLS, immutability)
  5. Rollback (empty data)
  6. Rollback fail-closed (production-like data)

## Files

| File | Purpose |
|---|---|
| `20260805012800_task1_ce_grounding_replay.sql` | Forward migration |
| `20260805012800_task1_ce_grounding_replay_rollback.sql` | Companion rollback |
| `harness/run.sh` | Test runner |
| `harness/00_baseline.sql` | Prerequisite schema |
| `harness/10_seed_baseline_data.sql` | Seed fixtures |
| `harness/20_tests_runtime.sql` | 25 runtime assertions |
| `harness/30_prodlike_data.sql` | Production-like data for fail-closed test |
| `harness/90_snapshot.sql` | Catalog snapshot |

These files are READ FROM the Lovable project at HEAD `4e60145c` and are
frozen. They must not be modified without re-running the full harness.
