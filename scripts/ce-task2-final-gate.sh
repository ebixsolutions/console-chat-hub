#!/usr/bin/env bash
set -euo pipefail
ZIP="${1:-}"; [ -f "$ZIP" ]||{ echo FINAL_GATE=FAIL; echo FINAL_STATUS=FAIL; exit 1; }; ZIP="$(cd "$(dirname "$ZIP")"&&pwd)/$(basename "$ZIP")"; TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$ZIP" "$TMP" <<'PYEX'
import zipfile,sys
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
PYEX
R="$TMP/repo"; [ -f "$R/MANIFEST.json" ]||R="$TMP"; cd "$R"; P=0; F=0; B=0; ok(){ P=$((P+1)); }; fl(){ F=$((F+1)); echo "FAIL: $1"; }; blk(){ B=$((B+1)); }
bash scripts/ce-task2-package-integrity.sh "$ZIP" "$ZIP.sha256"&&ok||fl package
[ "$(jq -r .package_version MANIFEST.json)" = nexusai-3task-current-27 ]&&ok||fl package_version
bash scripts/ce-task2-false-pass-scan.sh >/dev/null&&ok||fl false_pass
TR=$(jq -r .task_run_id validation/execution-metadata.json)
CT=$(jq -r .contract_id validation/execution-metadata.json)
PK=$(jq -r .package_version MANIFEST.json)
for n in database deno edge-contract frontend-build frontend-smoke; do
  f=validation/results/$n.json
  jq -e --arg t "$TR" --arg c "$CT" --arg p "$PK" '.task_run_id==$t and .contract_id==$c and .package_version==$p and (.generated_at|type=="string") and (.command|type=="string") and (.tested_source_hashes|type=="object") and (.pass|type=="number") and (.fail|type=="number") and (.skip|type=="number") and (.blocked|type=="number")' "$f" >/dev/null||{ fl "$n identity"; continue; }
  s=$(jq -r .status "$f"); e=$(jq -r .exit_code "$f"); ff=$(jq -r .fail "$f"); bb=$(jq -r .blocked "$f")
  if [ "$s" = PASS ]&&[ "$e" = 0 ]&&[ "$ff" = 0 ]&&[ "$bb" = 0 ]; then ok; elif [ "$s" = BLOCKED ]&&[ "$e" != 0 ]&&[ "$ff" = 0 ]&&[ "$bb" -gt 0 ]; then ok; blk; else fl "$n inconsistent"; fi
done
[ "$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json')).devDependencies['@lovable.dev/vite-tanstack-config'])")" = 2.7.1 ]&&ok||fl version
if [ "$F" -eq 0 ]&&[ "$B" -eq 0 ]; then echo "FINAL GATE: PASS=$P FAIL=0 BLOCKED=0 SKIP=0"; echo FINAL_GATE=PASS; echo FINAL_STATUS=READY; exit 0; elif [ "$F" -eq 0 ]; then echo "FINAL GATE: PASS=$P FAIL=0 BLOCKED=$B SKIP=0"; echo FINAL_GATE=BLOCKED; echo FINAL_STATUS=STOP; exit 2; else echo "FINAL GATE: PASS=$P FAIL=$F BLOCKED=$B SKIP=0"; echo FINAL_GATE=FAIL; echo FINAL_STATUS=FAIL; exit 1; fi
