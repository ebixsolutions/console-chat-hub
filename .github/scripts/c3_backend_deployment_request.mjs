import fs from "node:fs";
import path from "node:path";
import { runtimeDependencyClosure } from "./c3_module_graph.mjs";

/** Build only; never calls Supabase. Empty import_map_path is intentional. */
export function backendDeploymentRequest(root, projectId) {
  const config = JSON.parse(fs.readFileSync(path.join(root, "supabase/functions/deno.json"), "utf8"));
  if (Object.keys(config).some((key) => !["nodeModulesDir", "compilerOptions"].includes(key)) ||
      config.nodeModulesDir !== "auto" || config.compilerOptions?.strict !== true ||
      Object.keys(config.compilerOptions).some((key) => key !== "strict")) {
    throw new Error("runtime_deno_configuration_requires_explicit_review");
  }
  const closure = runtimeDependencyClosure({ root, entrypoints: ["supabase/functions/generate-reply/index.ts"] });
  const files = closure.map((name) => ({
    name: name.replace(/^supabase\/functions\//, ""),
    content: fs.readFileSync(path.join(root, name), "utf8"),
  }));
  // deno.json is compiler configuration in this candidate. Including it at the
  // deployment root let automatic discovery change import_map=false to true.
  const request = { project_id: projectId, name: "generate-reply", entrypoint_path: "generate-reply/index.ts",
    verify_jwt: true, import_map_path: "", files };
  assertBackendRequest(request, root);
  return request;
}

export function assertBackendRequest(request, root = path.resolve(import.meta.dirname, "../..")) {
  if (request.import_map === true || request.name !== "generate-reply" || request.verify_jwt !== true || request.import_map_path !== "" ||
      request.entrypoint_path !== "generate-reply/index.ts" || !request.files.length ||
      request.files.some((file) => /(?:^|\/)(?:deno\.jsonc?|import_map\.json)$/.test(file.name)) ||
      new Set(request.files.map((file) => file.name)).size !== request.files.length) {
    throw new Error("unsafe_backend_deployment_request");
  }
  const required = runtimeDependencyClosure({root,entrypoints:["supabase/functions/generate-reply/index.ts"]});
  const actual = request.files.map(file=>`supabase/functions/${file.name}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(required) || request.files.some(file=>
    file.content !== fs.readFileSync(path.join(root,"supabase/functions",file.name),"utf8"))) {
    throw new Error("backend_runtime_closure_or_content_mismatch");
  }
}
