from pathlib import Path

p = Path('supabase/functions/generate-reply/index.ts')
s = p.read_text()
needle = '    rag_match_state: _pr5RagMatchState,'
insert = '    warm_handoff_question: buildMissingFactsQuestion(buildWarmHandoffPackage(_pr5HistoryRows ?? [], "R2"), _visitorLang) ?? undefined,\n' + needle

parts = s.split('evaluateAndPersistRequiredRulesLive(supabaseAdmin, {')
out = [parts[0]]
changed = 0
for part in parts[1:]:
    # Only alter the current call object, never later text after its closing marker.
    head, sep, tail = part.partition('\n    });')
    if needle in head and 'warm_handoff_question:' not in head:
        head = head.replace(needle, insert, 1)
        changed += 1
    out.append('evaluateAndPersistRequiredRulesLive(supabaseAdmin, {' + head + sep + tail)

s2 = ''.join(out)
assert changed >= 3, f'expected at least 3 early R2-capable call sites, changed={changed}'
assert s2.count('warm_handoff_question:') >= s.count('warm_handoff_question:') + 3
p.write_text(s2)
print(f'WARM_HANDOFF_R2_CALLCHAIN_PATCHED={changed}')
