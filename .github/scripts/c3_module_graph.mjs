import fs from "node:fs";
import path from "node:path";

const fail = (message) => { throw new Error(message); };

function namedClauseHasRuntimeValue(clause) {
  const trimmed = clause.trim();
  if (!trimmed || /^type\b/u.test(trimmed)) return false;
  if (!trimmed.startsWith("{")) return true;
  const body = trimmed.slice(1, trimmed.lastIndexOf("}"));
  return body.split(",").some((specifier) => {
    const value = specifier.trim();
    return value && !/^type\b/u.test(value);
  });
}

/** Return only local modules that survive TypeScript type erasure. */
export function runtimeLocalImports(source) {
  const imports = new Set();
  const add = (specifier) => {
    if (specifier.startsWith(".")) imports.add(specifier);
  };

  for (const match of source.matchAll(/\bimport\s*["'](\.{1,2}\/[^"']+)["']/gu)) add(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/gu)) add(match[1]);

  const fromPattern = /^\s*(import|export)\s+((?:type\s+)?(?:\{[\s\S]*?\}|\*\s+as\s+[\w$]+|[\w$]+(?:\s*,\s*(?:\{[\s\S]*?\}|\*\s+as\s+[\w$]+))?|\*))\s+from\s+["'](\.{1,2}\/[^"']+)["']/gmu;
  for (const match of source.matchAll(fromPattern)) {
    if (namedClauseHasRuntimeValue(match[2])) add(match[3]);
  }
  return [...imports];
}

export function resolveLocalModule(root, importer, specifier) {
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const candidates = path.extname(unresolved)
    ? [unresolved]
    : [`${unresolved}.ts`, `${unresolved}.tsx`, `${unresolved}.js`, `${unresolved}.mjs`, `${unresolved}.json`, path.join(unresolved, "index.ts")];
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  const safeRoot = `${path.resolve(root)}${path.sep}`;
  if (!found || !found.startsWith(safeRoot)) return null;
  return found;
}

export function runtimeDependencyClosure({ root, entrypoints }) {
  const absoluteRoot = path.resolve(root);
  const pending = [...entrypoints];
  const seen = new Set();
  while (pending.length) {
    const relative = pending.pop().split(path.sep).join("/");
    if (seen.has(relative)) continue;
    const absolute = path.resolve(absoluteRoot, relative);
    if (!absolute.startsWith(`${absoluteRoot}${path.sep}`) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      fail(`runtime_file_missing_or_unsafe:${relative}`);
    }
    seen.add(relative);
    const source = fs.readFileSync(absolute, "utf8");
    for (const specifier of runtimeLocalImports(source)) {
      const found = resolveLocalModule(absoluteRoot, absolute, specifier);
      if (!found) fail(`runtime_dependency_missing_or_unsafe:${relative}:${specifier}`);
      pending.push(path.relative(absoluteRoot, found).split(path.sep).join("/"));
    }
  }
  return [...seen].sort();
}
