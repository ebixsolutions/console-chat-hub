#!/usr/bin/env python3
from pathlib import Path
import sys

root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
s=(root/"supabase/functions/generate-reply/index.ts").read_text()

# Must bind R3 to CE freshness state, not latest-created evaluation alone.
assert '.from("ce_evaluation_state")' in s
assert '.eq("company_id", expected_tenant_id)' in s
assert 'freshness.state !== "up_to_date"' in s
assert 'freshness.last_success_source !== "canonical"' in s
assert 'freshness.last_success_fingerprint !== freshness.current_evaluation_fingerprint' in s

# Must consume exactly the state-designated evaluation.
assert '.eq("id", freshness.last_success_evaluation_id)' in s
assert '.eq("freshness", "current")' in s
assert '.eq("evaluation_fingerprint", freshness.last_success_fingerprint)' in s

# New message activity after the evaluation invalidates advisory sentiment.
assert 'activityAt > successAt' in s

# Emotion points remain same-tenant and bound to the exact current evaluation.
assert '.eq("evaluation_id", evaluation.id)' in s
assert 'provider_version: `ce-emotion-point-v1.1:' in s

# Guard against the old unsafe selection pattern in the R3 loader.
start=s.index("async function loadAuthoritativeR3SentimentSignals")
end=s.index("interface ConversationHistorySignals", start)
block=s[start:end]
assert '.order("created_at", { ascending: false })' not in block
assert '.limit(1)' not in block

print("PASS product-ready CE freshness binding source contract")
