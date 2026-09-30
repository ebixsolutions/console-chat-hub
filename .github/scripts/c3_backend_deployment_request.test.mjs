import { test } from "node:test";
import assert from "node:assert/strict";
import { backendDeploymentRequest, assertBackendRequest } from "./c3_backend_deployment_request.mjs";
import { runtimeDependencyClosure } from "./c3_module_graph.mjs";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
test("compiler config stays in source; deployment has exact runtime closure and explicit no import map", () => {
  const request = backendDeploymentRequest(root, "local-contract-only");
  assert.deepEqual(request.files.map((file) => `supabase/functions/${file.name}`), runtimeDependencyClosure({ root, entrypoints: ["supabase/functions/generate-reply/index.ts"] }));
  for (const file of request.files) assert.equal(file.content, fs.readFileSync(path.join(root, "supabase/functions", file.name), "utf8"));
  assert.equal(request.import_map_path, "");
  assert.equal(request.verify_jwt, true);
  assert.ok(fs.existsSync(path.join(root, "supabase/functions/deno.json")));
  // v200 request omitted this field and included root deno.json. The v201
  // successful rollback explicitly reset the inherited absolute map path.
  assert.throws(() => assertBackendRequest({ ...request, import_map_path: undefined }));
  assert.throws(() => assertBackendRequest({ ...request, files: [...request.files, { name: "deno.json", content: "{}" }] }));
  assert.throws(() => assertBackendRequest({ ...request, import_map_path: "file:///tmp/v200/source/deno.json" }));
  assert.throws(() => assertBackendRequest({ ...request, verify_jwt: false }));
});
