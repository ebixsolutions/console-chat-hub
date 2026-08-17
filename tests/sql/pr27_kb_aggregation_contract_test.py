#!/usr/bin/env python3
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
kb = (root/"supabase/functions/_shared/kb-client.ts").read_text()
p = (root/"supabase/functions/_shared/kb-aggregation-response.ts").read_text()

for x in [
    "candidate_top_k",
    "max_summary_chunks",
    "max_full_content_chunks",
    "parseAggregationResponse(data)",
]:
    assert x in kb, x

for old in [
    'typeof d.has_context',
    'd.reason!=="ok"',
    'typeof d.llm_context!=="string"',
    'Array.isArray(d.documents)',
]:
    assert old not in kb, old

for x in [
    "data.context_found",
    "data.selected_documents",
    "data.llm_context",
    '"rag_summary"',
    '"full_content"',
    '"faq_pair"',
    '"section"',
    '"Knowledge Base document"',
]:
    assert x in p, x

print("PR27 KB AGGREGATION CONTRACT: PASS")

assert 'if (chunkType === "full_content")' in p
assert 'fullEvidence.push' in p
