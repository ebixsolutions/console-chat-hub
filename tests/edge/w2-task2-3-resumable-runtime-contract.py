#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
s=(r/"scripts/w2-task2-3-learning-loop-runtime-smoke.sh").read_text()

assert 'accepted) REVIEW_ACTION="resume"' in s
assert 'canonical CE review already accepted; resuming idempotently' in s
assert 'if [ "$DSTATUS" != "delivered" ]; then' in s
assert 'AI Chatbot -> SU CoachAI transport delivered/resumed idempotently' in s

# Invalid terminal review states remain blocked.
assert 'rejected|reopened) stop' in s

# Full learning safety remains unchanged.
for marker in [
    'su_coachai_verified_correction',
    'rag_new_content_verified',
    'training-kb-sync',
    'training-kb-finalize',
    'kb_rag_new_content_not_visible',
]:
    assert marker in s

# Do not weaken fixture uniqueness.
assert 'expected exactly one canonical evaluation for runtime fixture conversation' in s
print("PASS W2 Task2.3 resumable runtime source contract")
