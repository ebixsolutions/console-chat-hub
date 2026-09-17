#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localImports, verifyDeterministicClosure } from "./c3_deterministic_runtime_closure.mjs";

const result = verifyDeterministicClosure();
assert.equal(result.external_model_calls, 0);
assert.equal(result.external_api_cost_usd, 0);
assert.match(result.closure_sha256, /^[0-9a-f]{64}$/);
assert(localImports('import { x } from "./x.ts";').includes("./x.ts"));

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "c3-closure-"));
try {
  fs.mkdirSync(path.join(fixture, "x"));
  fs.writeFileSync(path.join(fixture, "x", "root.ts"), 'import "./llm-router.ts";\n');
  fs.writeFileSync(path.join(fixture, "x", "llm-router.ts"), "export {};\n");
  assert.throws(
    () => verifyDeterministicClosure({ root: fixture, roots: ["x/root.ts"] }),
    /model_router_reachable/,
  );
  fs.writeFileSync(
    path.join(fixture, "x", "root.ts"),
    'const endpoint = "https://api.openai.com/v1";\n',
  );
  assert.throws(
    () => verifyDeterministicClosure({ root: fixture, roots: ["x/root.ts"] }),
    /external_model_endpoint_reachable/,
  );
  fs.writeFileSync(path.join(fixture, "x", "root.ts"), 'await import("./safe.ts");\n');
  assert.throws(
    () => verifyDeterministicClosure({ root: fixture, roots: ["x/root.ts"] }),
    /dynamic_import_forbidden/,
  );
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log("c3 deterministic runtime closure tests: PASS");
