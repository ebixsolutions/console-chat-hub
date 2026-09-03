from pathlib import Path
p = Path('supabase/functions/_shared/llm-router.ts')
s = p.read_text()
old = '''      const decision = parseGroundingVerifierDecision(parsed.text, verifierEvidence.allowed_ids);
      if (!decision) {
        await recordUsage(
          verifierCall,
          verifierAdapter.id,
          verifierAdapter.model,
          "failed",
          res.status,
          verifierUsage,
          "GROUNDING_VERIFIER_INVALID_OUTPUT",
        );
        return { ok: false, reason: "verifier_invalid_output" };
      }
'''
new = '''      const decision = parseGroundingVerifierDecision(parsed.text, verifierEvidence.allowed_ids);
      if (!decision) {
        await recordUsage(
          verifierCall,
          verifierAdapter.id,
          verifierAdapter.model,
          "failed",
          res.status,
          verifierUsage,
          "GROUNDING_VERIFIER_INVALID_OUTPUT",
        );
        if (attempt < 2) {
          log(call.tag, {
            event: "grounding_verifier_invalid_output_retry",
            request_id: call.operationId,
            attempt,
          });
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        return { ok: false, reason: "verifier_invalid_output" };
      }
'''
assert old in s, 'verifier invalid-output block not found'
s = s.replace(old,new,1)
p.write_text(s)
print('TASK4_1_VERIFIER_INVALID_RETRY=APPLIED')