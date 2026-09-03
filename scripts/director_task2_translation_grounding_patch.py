#!/usr/bin/env python3
from pathlib import Path

p=Path('supabase/functions/_shared/llm-router.ts')
s=p.read_text(); original=s

def one(old,new):
    global s
    n=s.count(old)
    if n!=1: raise SystemExit(f'PATCH_EXPECTED_ONCE count={n}: {old[:100]!r}')
    s=s.replace(old,new,1)

one('''interface ParsedGroundingBlock {\n  authority: "CURRENT_KB" | "PRIOR_GROUNDED_ANSWER";\n  evidence_text: string;\n  chunk_ids: string[];\n}''','''interface ParsedGroundingBlock {\n  authority: "CURRENT_KB" | "PRIOR_GROUNDED_ANSWER";\n  evidence_text: string;\n  chunk_ids: string[];\n  transform_operations: string[];\n}''')

one('''function canonicalExactToken(value: string): string {\n  return value.normalize("NFKC").toLowerCase().replace(/[\\s,]/g, "").trim();\n}''','''function canonicalExactToken(value: string): string {\n  return value.normalize("NFKC").toLowerCase()\n    .replace(/percent/g, "%")\n    .replace(/(?:litres?|liters?|公升)/g, "l")\n    .replace(/(?:millilitres?|milliliters?|毫升)/g, "ml")\n    .replace(/(?:kilograms?|公斤)/g, "kg")\n    .replace(/(?:grams?|克)/g, "g")\n    .replace(/(?:hours?|小時|小时)/g, "h")\n    .replace(/(?:minutes?|分鐘|分钟)/g, "min")\n    .replace(/(?:days?|天|日)/g, "d")\n    .replace(/(?:years?|年)/g, "y")\n    .replace(/(?:months?|月)/g, "mo")\n    .replace(/[\\s,]/g, "").trim();\n}''')

one('''        return {\n          authority: "PRIOR_GROUNDED_ANSWER",\n          evidence_text: prior.slice(0, 3000),\n          chunk_ids: [],\n        };''','''        const operationsLine = system.match(/^- Operations:\\s*(.+)$/m)?.[1] ?? "";\n        const transformOperations = operationsLine.split("+").map((x) => x.trim()).filter(Boolean);\n        return {\n          authority: "PRIOR_GROUNDED_ANSWER",\n          evidence_text: prior.slice(0, 3000),\n          chunk_ids: [],\n          transform_operations: transformOperations,\n        };''')

one('''  return {\n    authority: "CURRENT_KB",\n    evidence_text: raw.slice(0, 6000),\n    chunk_ids: [...new Set(ids)],\n  };''','''  return {\n    authority: "CURRENT_KB",\n    evidence_text: raw.slice(0, 6000),\n    chunk_ids: [...new Set(ids)],\n    transform_operations: [],\n  };''')

one('''    grounding.authority === "PRIOR_GROUNDED_ANSWER"\n      ? "The evidence is a previously verified grounded answer. Judge whether the proposed answer is a faithful simplification, rephrase, translation, or summary of that evidence without any new factual claim. Wording and language may differ, and a summary may omit detail."\n      : "Judge ONLY whether every factual claim in the proposed answer is entailed by the supplied current Knowledge Base evidence.",''','''    grounding.authority === "PRIOR_GROUNDED_ANSWER"\n      ? "The evidence is a previously verified grounded answer. Judge whether the proposed answer is a faithful simplification, rephrase, translation, or summary of that evidence without any new factual claim. Wording and language may differ, and a summary may omit detail."\n      : "Judge ONLY whether every factual claim in the proposed answer is entailed by the supplied current Knowledge Base evidence.",\n    grounding.authority === "PRIOR_GROUNDED_ANSWER" && grounding.transform_operations.length\n      ? `Requested transform operations: ${grounding.transform_operations.join(" + ")}.`\n      : "",\n    grounding.authority === "PRIOR_GROUNDED_ANSWER" && grounding.transform_operations.includes("TRANSLATE")\n      ? "For TRANSLATE, compare semantic meaning across languages rather than surface-word overlap. Direct translations of the same names, product categories, units, and relationships are supported when they preserve the source meaning; do not reject a faithful translation merely because its words differ from the source language."\n      : "",''')

if s==original: raise SystemExit('PATCH_NO_CHANGES')
p.write_text(s)
print('DIRECTOR_TASK2_TRANSLATION_GROUNDING_PATCH=PASS')
