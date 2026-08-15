#!/bin/bash
set -u
REPO="${PR11_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
DEFAULT_CONFIG="$HOME/.config/console-chat-hub/pr12-production-activation.json"
CONFIG="${1:-$DEFAULT_CONFIG}"

stop(){ echo "STOP: $1"; exit 2; }

[ -d "$REPO/.git" ] || stop "authoritative repo unavailable"
cd "$REPO" || stop "cannot enter authoritative repo"
[ "$(git branch --show-current)" = "main" ] || stop "branch must be main"
[ -s scripts/pr12-product-ready-activation-loader.py ] || stop "activation loader missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

exec python3 scripts/pr12-product-ready-activation-loader.py "$CONFIG"
