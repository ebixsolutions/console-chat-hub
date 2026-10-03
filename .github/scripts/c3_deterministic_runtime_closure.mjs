#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveLocalModule, runtimeLocalImports } from "./c3_module_graph.mjs";

const ROOTS = [
  "supabase/functions/generate-reply/index.ts",
  "supabase/functions/agent-assist/index.ts",
  "supabase/functions/conversation-evaluate/index.ts",
  "supabase/functions/kb-search-proxy/index.ts",
  "supabase/functions/_shared/commerce-semantic-interpreter.ts",
  "supabase/functions/_shared/ce-automation-engine.ts",
  "supabase/functions/_shared/escalation-policy.ts",
];
const FORBIDDEN_FILES = ["llm-router.ts", "vertex-generation-config.ts"];
// This gate prohibits generation/model endpoints in the executable closure.
// Merchant KB retrieval is an evidence transport, not a model invocation; its
// tenant-scoped adapter is deliberately allowed and remains governed by the
// separate KB authority, citation and isolation gates.
const FORBIDDEN_MODEL_REMOTE =
  /(?:generativelanguage\.googleapis\.com|api\.anthropic\.com|api\.openai\.com|openai-compatible|ollama|vllm|huggingface)/iu;
const HASH = /^[0-9a-f]{64}$/;
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const must = (value, message) => {
  if (!value) throw new Error(message);
};

export const localImports = runtimeLocalImports;

export function verifyDeterministicClosure({ root = process.cwd(), roots = ROOTS } = {}) {
  const visited = new Set();
  const queue = roots.map((file) => path.resolve(root, file));
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    must(fs.existsSync(file), `closure_missing:${path.relative(root, file)}`);
    visited.add(file);
    const source = fs.readFileSync(file, "utf8");
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    must(!/\bimport\s*\(/u.test(source), `dynamic_import_forbidden:${relative}`);
    must(!FORBIDDEN_MODEL_REMOTE.test(source), `external_model_endpoint_reachable:${relative}`);
    for (const specifier of localImports(source)) {
      const target = resolveLocalModule(root, file, specifier);
      must(target, `closure_dependency_missing:${relative}:${specifier}`);
      must(
        !FORBIDDEN_FILES.some((name) => target.endsWith(name)),
        `model_router_reachable:${relative}:${specifier}`,
      );
      if (target.endsWith(".ts") || target.endsWith(".js") || target.endsWith(".mjs"))
        queue.push(target);
    }
  }
  const files = [...visited]
    .map((file) => path.relative(root, file).replaceAll(path.sep, "/"))
    .sort();
  must(
    files.includes("supabase/functions/_shared/deterministic-runtime-router.ts"),
    "deterministic_router_not_reachable",
  );
  const manifest = files.map((file) => ({
    file,
    sha256: sha(fs.readFileSync(path.resolve(root, file))),
  }));
  const closure_sha256 = sha(JSON.stringify(manifest));
  must(HASH.test(closure_sha256), "closure_hash_invalid");
  return {
    mode: "DETERMINISTIC_ONLY",
    external_model_calls: 0,
    external_api_cost_usd: 0,
    files: manifest,
    closure_sha256,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  const result = verifyDeterministicClosure();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
