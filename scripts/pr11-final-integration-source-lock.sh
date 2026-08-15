#!/bin/bash
set -u
set -o pipefail
stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }
pass(){ echo "PASS $1"; }

REPO="${PR11_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
AUTHORIZED="${PR11_AUTHORIZED_SOURCE_COMMIT:-}"
ROLLBACK="${PR7_ROLLBACK_COMMIT:-}"

[ -d "$REPO/.git" ] || stop "authoritative repo unavailable"
cd "$REPO" || stop "cannot enter authoritative repo"
[ "$(git branch --show-current)" = "main" ] || stop "branch must be main"
command -v git >/dev/null 2>&1 || stop "git missing"
command -v shasum >/dev/null 2>&1 || stop "shasum missing"

[[ "$AUTHORIZED" =~ ^[0-9a-fA-F]{40}$ ]] || stop "PR11_AUTHORIZED_SOURCE_COMMIT must be exact 40-char Git SHA"
[[ "$ROLLBACK" =~ ^[0-9a-fA-F]{40}$ ]] || stop "PR7_ROLLBACK_COMMIT must be exact 40-char Git SHA"
AUTHORIZED="$(printf '%s' "$AUTHORIZED" | tr '[:upper:]' '[:lower:]')"
ROLLBACK="$(printf '%s' "$ROLLBACK" | tr '[:upper:]' '[:lower:]')"

git cat-file -e "${AUTHORIZED}^{commit}" 2>/dev/null || stop "authorized source commit unavailable locally"
git cat-file -e "${ROLLBACK}^{commit}" 2>/dev/null || stop "rollback commit unavailable locally"

HEAD_SHA="$(git rev-parse HEAD | tr '[:upper:]' '[:lower:]')"
[ "$HEAD_SHA" = "$AUTHORIZED" ] || stop "local HEAD differs from authorized source commit"
pass "local HEAD equals authorized source commit"

STATUS="$(git status --porcelain=v1 --untracked-files=all)"
[ -z "$STATUS" ] || stop "tracked/staged/untracked source drift detected"
pass "tracked/staged/untracked source drift = 0"

REMOTE_LINE="$(git ls-remote --exit-code origin refs/heads/main 2>/dev/null)" || stop "cannot verify remote origin/main"
REMOTE_SHA="$(printf '%s\n' "$REMOTE_LINE" | awk 'NR==1{print tolower($1)}')"
[[ "$REMOTE_SHA" =~ ^[0-9a-f]{40}$ ]] || stop "remote origin/main returned invalid commit SHA"
[ "$REMOTE_SHA" = "$AUTHORIZED" ] || stop "remote origin/main differs from authorized source commit"
pass "remote origin/main equals authorized source commit"

git merge-base --is-ancestor "$ROLLBACK" "$AUTHORIZED" || fail "rollback commit is not ancestor of authorized source commit"
[ "$ROLLBACK" != "$AUTHORIZED" ] || fail "rollback commit must precede authorized source commit"
pass "rollback commit is prior ancestor"

CRITICAL=(
  package.json
  supabase/config.toml
  supabase/functions
  sql
  scripts/pr7-production-deploy.sh
  scripts/pr7-production-final-gate.sh
  scripts/pr11-whole-product-final-gate.sh
  scripts/pr11-final-product-ready-integration-runner.sh
)
for path in "${CRITICAL[@]}"; do
  git cat-file -e "${AUTHORIZED}:${path}" 2>/dev/null || fail "critical path absent from authorized commit: $path"
done
pass "production-critical paths tracked at authorized commit"

TREE_FP="$(
  for path in "${CRITICAL[@]}"; do
    git ls-tree -r "$AUTHORIZED" -- "$path"
  done | LC_ALL=C sort | shasum -a 256 | awk '{print $1}'
)"
[[ "$TREE_FP" =~ ^[0-9a-f]{64}$ ]] || fail "critical Git-tree fingerprint failed"
echo "PASS authorized critical-source tree fingerprint computed"
echo "AUTHORIZED_CRITICAL_SOURCE_SHA256=$TREE_FP"
echo "PR11 FINAL INTEGRATION SOURCE LOCK STATUS: PASS"
