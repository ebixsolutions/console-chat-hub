/** Bounded lossless JSON storage. This codec carries values, never authority.
 * Repeated keys, strings and identical structures share postorder table nodes.
 * The decoder verifies all budgets before allocating the expanded JSON tree.
 */
export type BoundedJsonValue = null | boolean | number | string | BoundedJsonValue[] |
  { [key: string]: BoundedJsonValue };
type Node = [0] | [1, boolean] | [2, number | "-0"] | [3, string] |
  [4, number[]] | [5, Array<[number, number]>];
export interface BoundedJsonStorage {
  version: "bounded-json-storage-1";
  nodes: Node[];
  root: number;
}
export const BOUNDED_JSON_STORAGE_LIMITS = Object.freeze({
  encodedCharacters: 16_384,
  maxNodes: 4_096,
  expandedCharacters: 131_072,
  maxDepth: 64,
});
export type BoundedJsonDecodeResult = { ok: true; value: BoundedJsonValue } | { ok: false };

const invalid = (): never => { throw new Error("INVALID_BOUNDED_JSON_STORAGE"); };
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && !!descriptor?.enumerable && Object.hasOwn(descriptor, "value");
  });
}
function denseArray(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return false;
  }
  return true;
}
function boundedSize(size: number): number {
  if (!Number.isSafeInteger(size) || size > BOUNDED_JSON_STORAGE_LIMITS.expandedCharacters) invalid();
  return size;
}

/** Synchronous, dependency-free and deterministic regardless of object-key
 * insertion order. Non-JSON values, cycles and exceeded bounds fail closed.
 */
export function encodeBoundedJsonStorage(value: unknown): BoundedJsonStorage | null {
  try {
    const nodes: Node[] = [], sizes: number[] = [], depths: number[] = [];
    const interned = new Map<string, number>();
    const memo = new WeakMap<object, number>(), active = new WeakSet<object>();
    let tableCharacters = 2;
    const intern = (node: Node, size: number, depth: number): number => {
      boundedSize(size);
      if (depth > BOUNDED_JSON_STORAGE_LIMITS.maxDepth) invalid();
      const signature = JSON.stringify(node), known = interned.get(signature);
      if (known !== undefined) return known;
      if (nodes.length >= BOUNDED_JSON_STORAGE_LIMITS.maxNodes) invalid();
      tableCharacters += signature.length + (nodes.length ? 1 : 0);
      if (tableCharacters > BOUNDED_JSON_STORAGE_LIMITS.encodedCharacters) invalid();
      const id = nodes.length;
      nodes.push(node); sizes.push(size); depths.push(depth); interned.set(signature, id);
      return id;
    };
    const visit = (current: unknown, depth: number): number => {
      if (depth > BOUNDED_JSON_STORAGE_LIMITS.maxDepth) invalid();
      if (current === null) return intern([0], 4, 0);
      if (typeof current === "boolean") return intern([1, current], current ? 4 : 5, 0);
      if (typeof current === "number") {
        if (!Number.isFinite(current)) invalid();
        return intern([2, Object.is(current, -0) ? "-0" : current], JSON.stringify(current).length, 0);
      }
      if (typeof current === "string") {
        if (current.length > BOUNDED_JSON_STORAGE_LIMITS.encodedCharacters) invalid();
        return intern([3, current], JSON.stringify(current).length, 0);
      }
      if (typeof current !== "object") return invalid();
      if (active.has(current)) invalid();
      const known = memo.get(current);
      if (known !== undefined) {
        if (depth + depths[known] > BOUNDED_JSON_STORAGE_LIMITS.maxDepth) invalid();
        return known;
      }
      active.add(current);
      let node: Node, size = 2, height = 0;
      if (Array.isArray(current)) {
        if (!denseArray(current, BOUNDED_JSON_STORAGE_LIMITS.encodedCharacters)) invalid();
        const refs: number[] = [];
        for (const entry of current) {
          const ref = visit(entry, depth + 1);
          size = boundedSize(size + sizes[ref] + (refs.length ? 1 : 0));
          height = Math.max(height, 1 + depths[ref]); refs.push(ref);
        }
        node = [4, refs];
      } else {
        if (!plainRecord(current)) return invalid();
        const entries: Array<[number, number]> = [];
        for (const key of Object.keys(current).sort()) {
          const keyRef = visit(key, depth + 1), valueRef = visit(current[key], depth + 1);
          size = boundedSize(size + sizes[keyRef] + 1 + sizes[valueRef] + (entries.length ? 1 : 0));
          height = Math.max(height, 1 + depths[valueRef]); entries.push([keyRef, valueRef]);
        }
        node = [5, entries];
      }
      const ref = intern(node, size, height);
      active.delete(current); memo.set(current, ref);
      return ref;
    };
    const root = visit(value, 0);
    const encoded: BoundedJsonStorage = { version: "bounded-json-storage-1", nodes, root };
    return JSON.stringify(encoded).length <= BOUNDED_JSON_STORAGE_LIMITS.encodedCharacters ? encoded : null;
  } catch {
    return null;
  }
}

/** Decode only validated backward references. Expansion constructs independent
 * objects for every JSON position, so interning never aliases two live states.
 * A success wrapper distinguishes a valid JSON null from a rejected envelope.
 */
export function decodeBoundedJsonStorage(value: unknown): BoundedJsonDecodeResult {
  try {
    if (!plainRecord(value) || Object.keys(value).length !== 3 ||
      !["version", "nodes", "root"].every(key => Object.hasOwn(value, key)) ||
      value.version !== "bounded-json-storage-1" ||
      !denseArray(value.nodes, BOUNDED_JSON_STORAGE_LIMITS.maxNodes) || !value.nodes.length ||
      value.root !== value.nodes.length - 1) return { ok: false };
    const nodes: Node[] = [], sizes: number[] = [], depths: number[] = [];
    let tableCharacters = 2;
    const ref = (candidate: unknown, before: number): number => {
      if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0 || candidate >= before) return invalid();
      return candidate;
    };
    for (const raw of value.nodes) {
      const index = nodes.length;
      if (!denseArray(raw, 2) || !raw.length) return { ok: false };
      let node: Node, size = 0, height = 0;
      if (raw[0] === 0 && raw.length === 1) { node = [0]; size = 4; }
      else if (raw[0] === 1 && raw.length === 2 && typeof raw[1] === "boolean") {
        node = [1, raw[1]]; size = raw[1] ? 4 : 5;
      } else if (raw[0] === 2 && raw.length === 2 &&
        (raw[1] === "-0" || typeof raw[1] === "number" && Number.isFinite(raw[1]))) {
        node = [2, raw[1]]; size = raw[1] === "-0" ? 1 : JSON.stringify(raw[1]).length;
      } else if (raw[0] === 3 && raw.length === 2 && typeof raw[1] === "string" &&
        raw[1].length <= BOUNDED_JSON_STORAGE_LIMITS.encodedCharacters) {
        node = [3, raw[1]]; size = JSON.stringify(raw[1]).length;
      } else if (raw[0] === 4 && raw.length === 2 &&
        denseArray(raw[1], BOUNDED_JSON_STORAGE_LIMITS.encodedCharacters)) {
        const refs = raw[1].map(entry => ref(entry, index));
        size = 2;
        for (const [position, child] of refs.entries()) {
          size = boundedSize(size + sizes[child] + (position ? 1 : 0));
          height = Math.max(height, 1 + depths[child]);
        }
        node = [4, refs];
      } else if (raw[0] === 5 && raw.length === 2 && denseArray(raw[1], BOUNDED_JSON_STORAGE_LIMITS.maxNodes)) {
        const entries: Array<[number, number]> = [], keys = new Set<string>();
        size = 2;
        for (const pair of raw[1]) {
          if (!denseArray(pair, 2) || pair.length !== 2) return { ok: false };
          const keyRef = ref(pair[0], index), valueRef = ref(pair[1], index), keyNode = nodes[keyRef];
          if (keyNode[0] !== 3 || keys.has(keyNode[1])) return { ok: false };
          keys.add(keyNode[1]);
          size = boundedSize(size + sizes[keyRef] + 1 + sizes[valueRef] + (entries.length ? 1 : 0));
          height = Math.max(height, 1 + depths[valueRef]); entries.push([keyRef, valueRef]);
        }
        node = [5, entries];
      } else return { ok: false };
      boundedSize(size);
      if (height > BOUNDED_JSON_STORAGE_LIMITS.maxDepth) return { ok: false };
      tableCharacters += JSON.stringify(node).length + (index ? 1 : 0);
      if (tableCharacters > BOUNDED_JSON_STORAGE_LIMITS.encodedCharacters) return { ok: false };
      nodes.push(node); sizes.push(size); depths.push(height);
    }
    if (JSON.stringify(value).length > BOUNDED_JSON_STORAGE_LIMITS.encodedCharacters) return { ok: false };
    const expand = (id: number): BoundedJsonValue => {
      const node = nodes[id];
      if (node[0] === 0) return null;
      if (node[0] === 1 || node[0] === 3) return node[1];
      if (node[0] === 2) return node[1] === "-0" ? -0 : node[1];
      if (node[0] === 4) return node[1].map(expand);
      const result: { [key: string]: BoundedJsonValue } = {};
      for (const [keyRef, valueRef] of node[1]) {
        const keyNode = nodes[keyRef];
        if (keyNode[0] !== 3) return invalid();
        Object.defineProperty(result, keyNode[1], { value: expand(valueRef), enumerable: true, writable: true, configurable: true });
      }
      return result;
    };
    return { ok: true, value: expand(nodes.length - 1) };
  } catch {
    return { ok: false };
  }
}
