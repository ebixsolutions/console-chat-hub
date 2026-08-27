#!/bin/bash
set -Eeuo pipefail

REPO="${AI_CHATBOT_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
RUNTIME_FILE="${W3_T3_3_RUNTIME_INPUT_FILE:-$HOME/.config/ebixpro/ai-chatbot/w3-task3-3-runtime.env}"
EXPECTED_REF="hvmtoqiwdqvgnjepxwrc"
stop(){ echo "STOP: $1" >&2; exit 2; }

[ -d "$REPO/.git" ] || stop "repo missing: $REPO"
[ "$(git -C "$REPO" branch --show-current)" = "main" ] || stop "branch must be main"
[ -z "$(git -C "$REPO" status --porcelain)" ] || stop "working tree must be clean"
[ -s "$REPO/config/w3-task3-3-dev-identity.env" ] || stop "Director DEV identity config missing"
[ -s "$RUNTIME_FILE" ] || stop "runtime input file missing; run w3-task3-3-runtime-inputs-setup.command first"

# Refuse stale local checkout before any activation.
git -C "$REPO" fetch origin main --quiet
LOCAL="$(git -C "$REPO" rev-parse HEAD)"
REMOTE="$(git -C "$REPO" rev-parse origin/main)"
[ "$LOCAL" = "$REMOTE" ] || stop "local main is not equal to origin/main; pull first"

# Load DEV config only to verify project identity. Secrets remain external.
# shellcheck disable=SC1090
source "$REPO/config/w3-task3-3-dev-identity.env"
[ "${W3_T3_3_PROJECT_REF:-}" = "$EXPECTED_REF" ] || stop "project ref mismatch"
[ "${W3_T3_3_DEV_CONFIG:-}" = "YES" ] || stop "DEV config flag missing"

printf '\nFINAL ACTIVATION TARGET\n'
printf 'Repo: %s\n' "$REPO"
printf 'Commit: %s\n' "$LOCAL"
printf 'Project ref: %s\n' "$W3_T3_3_PROJECT_REF"
printf 'Runtime secrets: %s\n\n' "$RUNTIME_FILE"

read -r -p "Type ACTIVATE to execute the authorized final DEV activation: " CONFIRM
[ "$CONFIRM" = "ACTIVATE" ] || stop "activation not confirmed"

export W3_T3_3_REPO="$REPO"
export W3_T3_3_RUNTIME_INPUT_FILE="$RUNTIME_FILE"
export W3_T3_3_PRODUCTION_AUTHORIZED=YES

cd "$REPO"
bash scripts/w3-task3-3-production-activate.sh

echo
echo "FINAL ACTIVATION COMMAND: PASS"
