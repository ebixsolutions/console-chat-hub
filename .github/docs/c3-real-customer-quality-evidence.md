# C3 real-customer quality evidence infrastructure

This infrastructure implements the source-only controls required by `C3_REAL_CUSTOMER_QUALITY_EVIDENCE_STANDARD_v1.0_2026-09-17.md` (SHA-256 `fbe34449386c52c416e23d4999b90ef0e627153fa01cdf9e9ba49c4c622d6198`). The standard is an external governance input and is not copied into this repository.

## Current state

- `REAL_CUSTOMER_DATASET=BLOCKED`
- `REAL_CUSTOMER_CASE_COUNT=0`
- `QUALITY_SCORE=NOT_MEASURED`
- `HUMAN_CALIBRATION=AWAITING`
- `PRODUCT_READY=false`

The earlier 100-case file remains available only as deterministic and synthetic runtime regression. Every case and the dataset are marked `source_type=synthetic_regression`, `quality_score=NOT_MEASURED`, and `held_out_real_customer=false`; it is not a real-customer quality denominator.

## Source approval boundary

The registry records publisher, paper, URLs, dataset version, download location, dataset terms, separate paper-license notes, real-human-dialogue evidence, PII status and restrictions. `BLOCKED` sources cannot be imported. A paper license is never promoted to a dataset license. No raw dialogue is stored in the registry.

The reviewed candidates are all blocked:

| Source | State | Blocking control |
| --- | --- | --- |
| JDDC v1 | BLOCKED | Dataset permission, reusable download and PII controls are unverified. |
| JDDC 2.0 | BLOCKED | Publisher authorization, dataset terms and multimodal PII clearance are absent. |
| U-NEED | BLOCKED | Authoritative download, dataset license and PII controls are unverified. |
| TweetSumm | BLOCKED | Stated CDLA terms do not resolve upstream platform-content rights and PII approval. |
| IBM Twitter customer care | BLOCKED | Underlying dialogue-content rights, platform terms and PII clearance are unresolved. |

## Pipeline boundaries

`c3_real_customer_dataset.mjs` verifies source binding, license binding, customer/agent human-role attestation, PII rejection, exact and semantic duplicates, translation equivalence review, source/case hashes, coverage and response-before-freeze rejection. Its freeze command uses exclusive creation and binds candidate HEAD/TREE, registry, dataset and every case hash. It cannot make a dataset READY unless all 100 cases meet the coverage contract.

`c3_nonproduction_independent_grader.mjs` does not call a provider and contains no provider, model, version or credential default. It requires the immutable raw artifact's expected canonical SHA-256, then binds its independent run identity, exact candidate, dataset, cases, requests, contexts and responses. It rejects self-reported aggregates and pass flags, replay, cross-release evidence, substituted responses, empty reasons, implementation-agent self-ratings, regex/length heuristics and fixed perfect scores. The repository computes all weighted and dimension aggregates.

`c3_human_blind_calibration.mjs` creates a 20-case packet without model identity, grader output, other reviewer output, expected results or oracle labels. Completed evidence needs at least two independent humans and 40 bound records; at least one reviewer must have Hong Kong customer-service or QA experience. The verifier computes Krippendorff's alpha with a threshold of 0.80 and requires a third blind adjudicator for a dimension gap above two points, P0 disagreement or PASS/FAIL conflict. Unit-test fixtures are explicitly test-only and are not human evidence.

The final gate exits nonzero until the real dataset is READY and separately verified real-customer execution, independent grading and blind human calibration are supplied. Deterministic and synthetic tests cannot change the quality state.

## Adopted interim: real-case derived evaluation

`C3_REAL_CASE_DERIVED_EVALUATION_INTERIM_v1.0` is implemented as an independent auxiliary evaluation profile. It does not replace, satisfy, or contribute to the Tier-A complete real-human customer↔agent dialogue denominator.

The fixed TweetSumm source is commit `4903b0f20665a59e4b5494abd83d8735893c0333`. TweetSumm states that its dataset is released under CDLA-Sharing-1.0 and asks users to cite *A Dialog Summarization Dataset for Customer Service*. The committed derived dataset uses only the publisher-provided human abstractive summaries and metadata. It does not store raw tweets, handles, URLs, or the upstream Customer Support on Twitter dialogue text. This is a use of the licensed TweetSumm summary dataset, not a workaround for upstream content restrictions.

The reproducible screening ledger contains all 251 keyword candidates. Each entry is source-file, source-line, conversation-ID, source-record-hash and summary-basis-hash bound, with an explicit selected/excluded decision. One hundred distinct ecommerce cases remain after rejecting non-commerce domains, insufficient facts and near duplicates. Every case is marked `DERIVED_ONLY`, preserves the explicit human-summary fact, records its derived question and transformation history, keeps historical agent action as reference-only, records unknown state, and forbids unsupported action or resolution claims. Market remains `UNKNOWN` throughout.

Freeze state:

- `DERIVED_CASE_COUNT=100`
- `ORIGINAL_A_CLASS_ELIGIBLE_DIALOGUE_COUNT=0`
- `RESPONSES_AT_FREEZE=0`
- `DERIVED_SCORE=NOT_MEASURED`
- `HUMAN_CALIBRATION=AWAITING`
- `PRODUCT_READY=false`

The derived freeze binds the starting candidate, source commit, screening ledger, dataset, rubric and every case hash. The independent-grader verifier uses a distinct derived evidence type and explicitly returns `product_ready_evidence=false`; the original A-class evidence type remains unchanged. The 20-case human packet is only `REVIEW_PREPARATION`: it defines two independent reviewer slots and at least 40 future records but contains no response, reviewer identity, review, reason, score or calibration claim.

No generation or grader provider/model/version/credential is selected by these files. Execution requires a new exact final HEAD/TREE authorization plus separate zero-cost, nonproduction-only generation and independent-grader identities. Human review begins only after immutable responses exist.
