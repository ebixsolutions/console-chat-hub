from pathlib import Path

gate = Path('.github/scripts/task_a3_final_gate.mjs')
assert gate.exists() and gate.stat().st_size > 0, 'STOP missing final gate'
s = gate.read_text()
old = 'execFileSync("deno", ["check", files.semanticFrame, files.semanticAdapter, files.semanticInterpreter], { stdio: "inherit" });'
new = 'execFileSync("deno", ["check", "--config", "supabase/functions/deno.json", files.semanticFrame, files.semanticAdapter, files.semanticInterpreter], { stdio: "inherit" });'
assert old in s or new in s, 'STOP semantic deno check baseline mismatch'
if old in s:
    s = s.replace(old, new, 1)
gate.write_text(s)
print('A3 TASK1 DENO CONFIG FIX PASS')
