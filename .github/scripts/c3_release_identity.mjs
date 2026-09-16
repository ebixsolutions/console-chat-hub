#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_SCHEMA = "ai-abc-c3-release-identity-1.0.0";
export const INTENT_SCHEMA = "ai-abc-c3-release-intent-1.0.0";
export const FUNCTIONS = Object.freeze(["generate-reply", "agent-assist"]);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const required = (value, name) => {
  if (typeof value !== "string" || !value.trim()) fail(`missing:${name}`);
  return value;
};
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
export const canonicalJson = (value) => JSON.stringify(canonical(value));
export const digestObject = (value) => `sha256:${sha(canonicalJson(value))}`;

function dependencyClosurePaths(root, entrypoint) {
  const pending = [entrypoint];
  const seen = new Set();
  while (pending.length) {
    const relative = pending.pop();
    if (seen.has(relative)) continue;
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      fail(`target_file_missing_or_unsafe:${relative}`);
    }
    seen.add(relative);
    const source = fs.readFileSync(absolute, "utf8");
    const imports = [...source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)].map((match) => match[1]);
    for (const specifier of imports) {
      const unresolved = path.resolve(path.dirname(absolute), specifier);
      const candidates = path.extname(unresolved) ? [unresolved] : [`${unresolved}.ts`, `${unresolved}.json`, path.join(unresolved, "index.ts")];
      const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!found || !found.startsWith(`${root}${path.sep}`)) fail(`relative_dependency_missing_or_unsafe:${relative}:${specifier}`);
      pending.push(path.relative(root, found).split(path.sep).join("/"));
    }
  }
  return [...seen].sort();
}

export function createTargetManifest({ functionName, sourceRoot, template, head, tree }) {
  if (!FUNCTIONS.includes(functionName)) fail(`function_not_allowed:${functionName}`);
  const root = path.resolve(sourceRoot);
  if (template && (!Array.isArray(template.files) || template.files.length === 0)) fail("closure_template_files_missing");
  const entrypoint = `${functionName}/index.ts`;
  const files = dependencyClosurePaths(root, entrypoint).map((relative) => {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`) || !fs.statSync(absolute).isFile()) fail(`target_file_missing_or_unsafe:${relative}`);
    return { path: relative, sha256: sha(fs.readFileSync(absolute)) };
  });
  const manifest = {
    schema_version: "ai-abc-c3-target-manifest-1.0.0",
    repository: "ebixsolutions/console-chat-hub",
    project: "nrfxhqabwblzxoushgnm",
    function: functionName,
    head: required(head, "head"),
    tree: required(tree, "tree"),
    entrypoint,
    verify_jwt: true,
    import_map: false,
    file_count: files.length,
    files,
  };
  return { ...manifest, manifest_sha256: sha(Buffer.from(canonicalJson(manifest) + "\n")) };
}

export function verifyActualAgainstTarget(target, actual) {
  for (const key of ["project", "function", "verify_jwt", "import_map", "file_count"]) {
    if (actual[key] !== target[key]) fail(`actual_target_${key}_mismatch:${target.function}`);
  }
  const expected = new Map(target.files.map((row) => [row.path, row.sha256]));
  const observed = new Map(actual.files.map((row) => [row.path, row.sha256]));
  const missing = [...expected.keys()].filter((key) => !observed.has(key));
  const unexpected = [...observed.keys()].filter((key) => !expected.has(key));
  const mismatch = [...expected].filter(([key, value]) => observed.has(key) && observed.get(key) !== value).map(([key]) => key);
  if (missing.length || unexpected.length || mismatch.length) {
    fail(`actual_target_source_mismatch:${target.function}:missing=${missing.length}:unexpected=${unexpected.length}:hash=${mismatch.length}`);
  }
  if ("status" in actual && (actual.status !== "ACTIVE" || !Number.isInteger(actual.version) || actual.version < 1 || !/^[0-9a-f]{64}$/.test(String(actual.bundle ?? "")))) {
    fail(`actual_runtime_identity_invalid:${target.function}`);
  }
  return { function: target.function, missing: 0, unexpected: 0, hash_mismatch: 0, result: "PASS" };
}

export function createReleaseIdentity(input) {
  const baseline = input.baseline;
  if (!baseline || !/^sha256:[0-9a-f]{64}$/.test(String(baseline.artifact_digest ?? ""))) fail("baseline_artifact_identity_invalid");
  const target = input.target;
  if (!target || target.head !== input.head || target.tree !== input.tree) fail("target_commit_identity_mismatch");
  for (const fn of FUNCTIONS) {
    if (!target.functions?.[fn]?.manifest_sha256) fail(`target_manifest_missing:${fn}`);
  }
  const core = {
    schema_version: RELEASE_SCHEMA,
    repository: "ebixsolutions/console-chat-hub",
    project: "nrfxhqabwblzxoushgnm",
    head: required(input.head, "head"),
    tree: required(input.tree, "tree"),
    deployment_run_id: String(required(String(input.deployment_run_id ?? ""), "deployment_run_id")),
    deployment_attempt: String(required(String(input.deployment_attempt ?? ""), "deployment_attempt")),
    baseline,
    target,
    actual: input.actual ?? null,
    cleanup_manifest_name: input.cleanup_manifest_name ?? null,
  };
  const releaseId = sha(Buffer.from(canonicalJson(core)));
  return { ...core, release_id: releaseId, release_digest: digestObject(core) };
}

export function createReleaseIntent(input) {
  const baseline = input.baseline;
  if (!baseline || !/^sha256:[0-9a-f]{64}$/.test(String(baseline.artifact_digest ?? ""))) fail("baseline_artifact_identity_invalid");
  if (!input.target || input.target.head !== input.head || input.target.tree !== input.tree) fail("target_commit_identity_mismatch");
  for (const fn of FUNCTIONS) if (!input.target.functions?.[fn]?.manifest_sha256) fail(`target_manifest_missing:${fn}`);
  const core = {
    schema_version: INTENT_SCHEMA, repository: "ebixsolutions/console-chat-hub", project: "nrfxhqabwblzxoushgnm",
    head: required(input.head, "head"), tree: required(input.tree, "tree"),
    deployment_run_id: String(required(String(input.deployment_run_id ?? ""), "deployment_run_id")),
    deployment_attempt: String(required(String(input.deployment_attempt ?? ""), "deployment_attempt")),
    baseline, target: input.target,
  };
  const intentId = sha(Buffer.from(canonicalJson(core)));
  return { ...core, intent_id: intentId, intent_digest: digestObject(core) };
}

export function verifyReleaseIntent(intent, expected = {}) {
  if (intent.schema_version !== INTENT_SCHEMA) fail("release_intent_schema_invalid");
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && String(intent[key]) !== String(value)) fail(`release_intent_${key}_mismatch`);
  }
  const reconstructed = createReleaseIntent(intent);
  if (reconstructed.intent_id !== intent.intent_id || reconstructed.intent_digest !== intent.intent_digest) fail("release_intent_digest_invalid");
  return { intent_id: intent.intent_id, result: "PASS" };
}

export function verifyReleaseIdentity(release, expected = {}) {
  if (release.schema_version !== RELEASE_SCHEMA) fail("release_schema_invalid");
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && String(release[key]) !== String(value)) fail(`release_${key}_mismatch`);
  }
  const reconstructed = createReleaseIdentity(release);
  if (reconstructed.release_id !== release.release_id || reconstructed.release_digest !== release.release_digest) fail("release_digest_invalid");
  if (!release.actual) fail("postdeploy_actual_missing");
  for (const fn of FUNCTIONS) verifyActualAgainstTarget(release.target.functions[fn], release.actual.functions[fn]);
  return { release_id: release.release_id, result: "PASS" };
}

export function verifyReleaseArtifactRoot(rootPath, release) {
  const root = path.resolve(rootPath);
  for (const fn of FUNCTIONS) {
    const source = path.join(root, "actual", fn, "supabase", "functions");
    const expected = new Map(release.actual.functions[fn].files.map((row) => [row.path, row.sha256]));
    const actual = new Map();
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile()) actual.set(path.relative(source, absolute).split(path.sep).join("/"), sha(fs.readFileSync(absolute)));
      }
    };
    if (!fs.existsSync(source)) fail(`release_actual_source_missing:${fn}`);
    visit(source);
    if (expected.size !== actual.size || [...expected].some(([name, digest]) => actual.get(name) !== digest)) fail(`release_actual_source_roundtrip_mismatch:${fn}`);
  }
  return { result: "PASS" };
}

export function authorizeValidationChild(release, input) {
  verifyReleaseIdentity(release, { head: input.head, tree: input.tree, deployment_run_id: input.deployment_run_id });
  if (String(input.parent_attempt) !== String(release.deployment_attempt)) fail("validation_parent_attempt_mismatch");
  if (input.release_digest !== release.release_digest) fail("validation_release_digest_mismatch");
  const expected = `c3-validation-${release.head}-${release.tree}-${release.release_id}`;
  if (input.authorization !== expected) fail("validation_authorization_invalid");
  return { release_id: release.release_id, result: "PASS" };
}

export function planRecovery(release, input) {
  verifyReleaseIdentity(release);
  const expected = `c3-recovery-${release.release_id}-${input.validation_run_id}`;
  if (input.authorization !== expected) fail("recovery_authorization_invalid");
  if (String(input.parent_deployment_run_id) !== String(release.deployment_run_id)) fail("recovery_parent_run_mismatch");
  if (input.validation_result !== "failure") fail("recovery_requires_failed_validation");
  const actions = [];
  for (const fn of FUNCTIONS) {
    const live = input.live?.[fn];
    const target = release.target.functions[fn];
    const baseline = release.baseline.functions?.[fn];
    if (!live) fail(`recovery_live_readback_missing:${fn}`);
    if (live.manifest_sha256 === baseline?.manifest_sha256) continue;
    if (live.manifest_sha256 !== target.manifest_sha256) fail(`recovery_external_or_parallel_drift:${fn}`);
    actions.push({ function: fn, restore_manifest_sha256: baseline.manifest_sha256 });
  }
  return { release_id: release.release_id, actions, result: "AUTHORIZED_PLAN" };
}

function parseArgs(argv) {
  const out = { command: argv[2] ?? "" };
  for (let i = 3; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}

function write(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function main() {
  const args = parseArgs(process.argv);
  if (args.command === "target") {
    const manifest = createTargetManifest({
      functionName: required(args.function, "--function"),
      sourceRoot: required(args["source-root"], "--source-root"),
      template: json(required(args.template, "--template")),
      head: required(args.head, "--head"),
      tree: required(args.tree, "--tree"),
    });
    write(required(args.out, "--out"), manifest);
    console.log(`C3_TARGET_MANIFEST|function=${manifest.function}|files=${manifest.file_count}|sha256=${manifest.manifest_sha256}|result=PASS`);
    return;
  }
  if (args.command === "verify-release") {
    const release = json(required(args.release, "--release"));
    const result = verifyReleaseIdentity(release, {
      head: args.head, tree: args.tree, deployment_run_id: args["deployment-run-id"],
    });
    if (args.root) verifyReleaseArtifactRoot(args.root, release);
    console.log(`C3_RELEASE_IDENTITY|release_id=${result.release_id}|result=PASS`);
    return;
  }
  if (args.command === "actual") {
    const target = json(required(args.target, "--target"));
    const rawMetadata = json(required(args.metadata, "--metadata"));
    const metadataRows = Array.isArray(rawMetadata) ? rawMetadata : rawMetadata.functions;
    if (!Array.isArray(metadataRows)) fail("actual_metadata_shape_invalid");
    const metadata = metadataRows.find((row) => (row.slug ?? row.name) === args.function);
    if (!metadata) fail(`actual_metadata_missing:${args.function}`);
    const actual = createTargetManifest({
      functionName: required(args.function, "--function"),
      sourceRoot: required(args["source-root"], "--source-root"),
      template: target,
      head: target.head,
      tree: target.tree,
    });
    verifyActualAgainstTarget(target, actual);
    const observed = {
      ...actual,
      manifest_sha256: target.manifest_sha256,
      version: Number(metadata.version),
      status: required(metadata.status, "metadata.status"),
      bundle: required(metadata.ezbr_sha256, "metadata.ezbr_sha256"),
      verify_jwt: metadata.verify_jwt,
      import_map: metadata.import_map === true,
    };
    verifyActualAgainstTarget(target, observed);
    write(required(args.out, "--out"), observed);
    console.log(`C3_ACTUAL_MANIFEST|function=${observed.function}|version=${observed.version}|sha256=${observed.manifest_sha256}|result=PASS`);
    return;
  }
  if (args.command === "create-release") {
    const release = createReleaseIdentity(json(required(args.input, "--input")));
    verifyReleaseIdentity(release);
    write(required(args.out, "--out"), release);
    console.log(`C3_RELEASE_IDENTITY|release_id=${release.release_id}|digest=${release.release_digest}|result=PASS`);
    return;
  }
  if (args.command === "create-intent") {
    const intent = createReleaseIntent(json(required(args.input, "--input")));
    verifyReleaseIntent(intent);
    write(required(args.out, "--out"), intent);
    console.log(`C3_RELEASE_INTENT|intent_id=${intent.intent_id}|digest=${intent.intent_digest}|result=PASS`);
    return;
  }
  if (args.command === "verify-intent") {
    const result = verifyReleaseIntent(json(required(args.intent, "--intent")), {
      head: args.head, tree: args.tree, deployment_run_id: args["deployment-run-id"],
    });
    console.log(`C3_RELEASE_INTENT|intent_id=${result.intent_id}|result=PASS`);
    return;
  }
  if (args.command === "authorize-validation") {
    const release = json(required(args.release, "--release"));
    const result = authorizeValidationChild(release, {
      head: required(args.head, "--head"), tree: required(args.tree, "--tree"),
      deployment_run_id: required(args["deployment-run-id"], "--deployment-run-id"),
      parent_attempt: required(args["deployment-attempt"], "--deployment-attempt"),
      release_digest: required(args["release-digest"], "--release-digest"),
      authorization: required(args.authorization, "--authorization"),
    });
    if (release.release_id !== required(args["release-id"], "--release-id")) fail("validation_release_id_mismatch");
    console.log(`C3_VALIDATION_CHILD_AUTHORIZATION|release_id=${result.release_id}|result=PASS`);
    return;
  }
  fail(`unsupported_command:${args.command}`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { main(); } catch (error) {
    console.error(`C3_RELEASE_IDENTITY|result=FAIL|reason=${error.message}`);
    process.exitCode = 1;
  }
}
