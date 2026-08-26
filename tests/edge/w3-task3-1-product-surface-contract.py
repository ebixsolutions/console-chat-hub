#!/usr/bin/env python3
from pathlib import Path
import sys

root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
cfg=(root/"src/config/aiChatbotProductConfig.ts").read_text(encoding="utf-8")
shim=(root/"src/mock/aiChatbotSettingsMock.ts").read_text(encoding="utf-8")
svc=(root/"src/services/aiChatbotSettingsService.ts").read_text(encoding="utf-8")

assert "mockChannelConfigs" not in cfg
assert "mockFeedbackRequests" not in cfg
assert "mockFeedbackAutomationConfig" not in cfg
assert "mock_preview" not in cfg
assert 'export * from "@/config/aiChatbotProductConfig";' in shim
assert "mockChannelConfigs" not in shim
assert "mockFeedbackRequests" not in shim
assert 'from "@/config/aiChatbotProductConfig"' in svc
assert 'from "@/mock/aiChatbotSettingsMock"' not in svc
assert 'source: "error"' in svc
assert 'source: "unconfigured"' in svc
assert 'return { data: res.data.map(deriveChannel), source: "live" };' in svc
assert 'feedbackService.listFeedbackResponses' in svc
assert 'status: "live"' in svc
assert 'status: "coming_soon"' in svc
print("PASS W3 Task 3.1 product-surface source contract")
