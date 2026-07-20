## Capability check: deploy only the `transfer-conversation` Edge Function

1. **Can a single function be deployed without touching source/config/package files?**
   Yes. The project has a `supabase--deploy_edge_functions` tool whose input schema accepts an array of function names. Calling it with `["transfer-conversation"]` deploys only that function and does not edit source files, `package.json`, or `supabase/config.toml`. The function code already exists at `supabase/functions/transfer-conversation/index.ts` and is valid; the only `supabase/config.toml` entries currently present are for other functions, so `transfer-conversation` will deploy with the default `verify_jwt = false` (no per-function block needed).

2. **Exact process to deploy just that one function**
   - Invoke `supabase--deploy_edge_functions` with `{ "function_names": ["transfer-conversation"] }`.
   - No other CLI command or file change is required. The tool deploys the existing `supabase/functions/transfer-conversation/index.ts` source to the Supabase project referenced in `supabase/config.toml` (`project_id = "hvmtoqiwdqvgnjepxwrc"`).

3. **Rollback feasibility**
   Yes. If the source file is reverted in the editor, the same single-function deployment can be repeated with the same tool and the same `function_names` value. It will overwrite the previously deployed version with the reverted source. No other function or file is affected.

4. **Evidence of successful deployment**
   - The tool returns a success/failure message (e.g., "Edge Function `transfer-conversation` deployed successfully"). Previous deployments in this project show that the tool response does not reliably include a deployment ID or timestamp.
   - Post-deployment verification can be done with `supabase--edge_function_logs` for `transfer-conversation` to confirm the function is responding and/or booting.
   - No version/SHA or timestamp is surfaced in the tool response or in the repository files by the deployment itself.

5. **Repository modifications**
   None. The deployment process writes only to the Supabase backend; it does not modify any file in the repository, including `package.json`, `supabase/config.toml`, lockfiles, or generated route files. If a function block is missing, the deployment will not add it to `config.toml` (default behavior is fine).

---

### Important constraints
- The function currently exists and has no syntax errors that would prevent deployment, but it references shared helpers (`../_shared/cors.ts`, `../_shared/agent.ts`), which must remain intact.
- No secrets, config, or other functions are touched by the single-function deployment process.
- This plan describes the action only; no deployment, file change, command execution, or secret change will be performed unless you approve the next step.