from pathlib import Path
p = Path('supabase/functions/_shared/conversation-runtime-state.ts')
s = p.read_text()
# v3 patch intentionally uses readable Python triple strings; normalize only TS quoted newline separators.
s2 = s.replace('parts.join("\n\n")', 'parts.join("\\n\\n")')
if s2 == s:
    raise SystemExit('NORMALIZE_PATTERN_NOT_FOUND')
p.write_text(s2)
print('INTEGRATED_GENERATED_SOURCE_NORMALIZED=PASS')
