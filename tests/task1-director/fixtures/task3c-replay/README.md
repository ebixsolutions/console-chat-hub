# Task3C preserved replay inputs

This directory preserves original contract inputs and original synthetic industry seeds under the existing test tree. It does not add a gate, replace original IDs, or establish a Hosted or model-quality result.

## Original remaining inputs

`original-33-turns.json` contains 33 exact input texts across the 13 original case IDs. Its provenance points to `.github/scripts/c3_validation_scenarios.json`, including the SHA256 of that source and its contract version. It is an inventory of the remaining scope; the original full 15-row contract remains authoritative. T06 and C3-CONTROL-15 are not renumbered or removed from the original contract. Existing contract example names, addresses and telephone strings are retained exactly. No additional live-customer record is included.

## Original synthetic industry seeds

`industry-seeds/inventory.json` indexes retail, SaaS, beauty, restaurant, education and B2B wholesale. Each domain has `policy.txt`, `knowledge.txt` and `tasks.json`: 18 content files, 30 supplemental tasks. All are marked NOT_RUN. Company UUIDs and KB tenant values are synthetic fixture identifiers. No company profile is installed into runtime, and no model-improvement claim is made. Profiles provide vocabulary only; they are not merchant fact, permission, current price or transaction authority.

Task mappings link to original cases and existing tests; they do not replace or shrink them. A future local replay may use hand-authored semantic frames only when explicitly marked SCRIPTED_NOT_REAL_MODEL. A generated fixture answer must never establish real-model or Hosted acceptance.

## Execution boundary

There is deliberately no copied live-snapshot replay harness in this directory. The earlier private replay used a read-only live snapshot and captured provider traces; those inputs and any derived replies, diagnostics or identifiers are excluded from Source. The existing full-handler tests in `tests/emergency-p0/chain.test.mjs` remain the executable isolated runtime coverage. Their external calls are fixtures. `tests/task1-director/quantity-source-scope.test.mjs` supplies the source-bound quantity regression, and `supabase/functions/_shared/llm-router-grounding.test.ts` supplies private-field disclosure and exact grounding unit coverage.

## CI integration

The quantity test is included in the existing Task1-director Node test commands in the original C3 workflow. llm-router-grounding.test.ts is included in the existing Deno grounding command in c3-preproduction. Do not create a new job, workflow, approval or gate. No paid model or KB dispatch is required by these isolated tests.

B2B wholesale rows are original synthetic observations only: no real customer case, genuine Singapore KB, real semantic model, Hosted dispatch or acceptance is implied. The 30 seeds are optional P1 observation material and do not change P1's original mandatory case denominator; P3 remains separately required.
