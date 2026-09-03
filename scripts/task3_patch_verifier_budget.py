from pathlib import Path

PATH = Path("supabase/functions/_shared/llm-router.ts")
s = PATH.read_text()

constant = "export const GROUNDING_VERIFIER_MAX_TOKENS = 2048;"
if constant not in s:
    anchor = "export const GENERATION_MAX_TOKENS_DEFAULT = 2048;"
    assert s.count(anchor) == 1, "generation token anchor mismatch"
    s = s.replace(anchor, constant + "\n\n" + anchor, 1)

replacements = {
    "redact(verifierUser),\n      512,\n      true,": "redact(verifierUser),\n      GROUNDING_VERIFIER_MAX_TOKENS,\n      true,",
    "redact(verifierUser),\n      512,\n    );": "redact(verifierUser),\n      GROUNDING_VERIFIER_MAX_TOKENS,\n    );",
    "maxTokens: 512,\n    operationId: `${call.operationId}:grounding-verifier`,": "maxTokens: GROUNDING_VERIFIER_MAX_TOKENS,\n    operationId: `${call.operationId}:grounding-verifier`,",
}
for old, new in replacements.items():
    if old in s:
        assert s.count(old) == 1, f"ambiguous verifier budget target: {old!r}"
        s = s.replace(old, new, 1)
    else:
        assert new in s, f"verifier budget target missing: {old!r}"

assert s.count("GROUNDING_VERIFIER_MAX_TOKENS") == 4, "expected constant + 3 verifier usages"
assert "redact(verifierUser),\n      512," not in s
assert "maxTokens: 512,\n    operationId: `${call.operationId}:grounding-verifier`," not in s
PATH.write_text(s)
print("TASK3_VERIFIER_BUDGET_PATCH=PASS")
