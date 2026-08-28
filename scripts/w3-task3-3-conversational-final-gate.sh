#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[Task3.3] conversation intelligence + continuous multi-turn matrix"
node --experimental-strip-types tests/edge/w3-task3-3-conversation-intelligence.ts

echo "[Task3.3] source/call-chain contract"
python3 tests/edge/w3-task3-3-conversational-runtime-contract.py

echo "[Task3.3] package marker"
node -e "const p=require('./package.json'); if(p.devDependencies['@lovable.dev/vite-tanstack-config']!=='2.13.1') process.exit(1); console.log('PASS package marker 2.13.1')"

echo "[Task3.3] production build"
npm run build

echo "PASS Task 3.3 conversational final gate"
