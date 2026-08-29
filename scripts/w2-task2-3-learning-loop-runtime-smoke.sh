#!/usr/bin/env bash
set -Eeuo pipefail

# Historical W2 entrypoint retained for compatibility. The authoritative Task 2.3
# smoke now lives in task2-3-learning-loop-runtime-smoke.sh and is hard-bound to
# the migrated Supabase project. No legacy Lovable-managed backend is accepted.
exec "$(cd "$(dirname "$0")" && pwd)/task2-3-learning-loop-runtime-smoke.sh" "$@"
