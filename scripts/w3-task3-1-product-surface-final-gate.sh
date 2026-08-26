#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

python3 tests/edge/w3-task3-1-product-surface-contract.py "$ROOT"

# Product runtime must not import historical mock fallback implementations.
if grep -R -n -E \
  'mockChannelConfigs|mockFeedbackRequests|mockFeedbackAutomationConfig|mock_preview|MockCustomer360ResponseSchema|MockCoachAIResponseSchema|MockAISuggestionResponseSchema' \
  src/routes src/services src/lib src/components 2>/dev/null; then
  echo "FAIL: production surface still references mock/fallback runtime data" >&2
  exit 1
fi

# No service may use the legacy mock settings module after this task.
if grep -R -n 'from "@/mock/aiChatbotSettingsMock"' src/services 2>/dev/null; then
  echo "FAIL: service layer still imports legacy mock settings module" >&2
  exit 1
fi

# Compatibility shim is allowed only as a data-free re-export while the large
# feedback route remains frozen; it must contain no customer/demo rows.
python3 - <<'PY'
from pathlib import Path
p=Path("src/mock/aiChatbotSettingsMock.ts")
s=p.read_text()
assert 'export * from "@/config/aiChatbotProductConfig";' in s
for marker in ("Mary Lee","conv-8016","Mock mode","mockChannelConfigs","mockFeedbackRequests","mockFeedbackAutomationConfig"):
    assert marker not in s, marker
print("PASS legacy settings module is data-free compatibility only")
PY

echo "W3 TASK 3.1 PRODUCT SURFACE SOURCE STATUS: PASS"
