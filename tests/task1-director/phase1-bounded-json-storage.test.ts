/** Lossless storage evidence only: the codec supplies no customer/merchant
 * authority. Uses the exact captured offline W19 committed state as data. */
import { BOUNDED_JSON_STORAGE_LIMITS, decodeBoundedJsonStorage, encodeBoundedJsonStorage,
  type BoundedJsonValue } from "../../supabase/functions/_shared/bounded-json-storage.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a).sort(), right = Object.keys(b).sort();
  return JSON.stringify(left) === JSON.stringify(right) && left.every(key =>
    same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
const envelope = (nodes: unknown[], root: unknown = nodes.length - 1) => ({ version: "bounded-json-storage-1", nodes, root });

Deno.test("P1 bounded JSON: exact captured W19 committed state survives the original storage budget", async () => {
  const fixture = JSON.parse(await Deno.readTextFile(new URL("./fixtures/phase1-large-lifecycle-memory.json", import.meta.url)));
  const original = fixture.args.commerce_state;
  assert(original && Array.isArray(original.entities) && original.entities.length >= 2, "Captured state fixture missing");
  const originalText = JSON.stringify(original), encoded = encodeBoundedJsonStorage(original);
  assert(encoded, "Exact captured canonical state could not be losslessly encoded");
  const encodedText = JSON.stringify(encoded), decoded = decodeBoundedJsonStorage(JSON.parse(encodedText));
  assert(decoded.ok && same(decoded.value, original), "Captured state/provenance changed in codec round trip");
  assert(encodedText.length < originalText.length && encodedText.length <= 16_384,
    "Actual captured state did not shrink within the unchanged Memory limit");
  assert(JSON.stringify(original) === originalText, "Encoder changed its canonical input");
  console.log(JSON.stringify({ bounded_json_case: "captured-W19-state", original_characters: originalText.length,
    encoded_characters: encodedText.length, unique_nodes: encoded.nodes.length,
    ratio: encodedText.length / originalText.length, canonical_equal: decoded.ok && same(decoded.value, original) }));
});

Deno.test("P1 bounded JSON: keys strings identical arrays and objects are interned losslessly", () => {
  const shared = { source: "customer", revision: 42, rows: [{ key: "quantity", value: 3 }, { key: "quantity", value: 1 }] };
  const original = { before: shared, after: structuredClone(shared), keys: ["source", "quantity", "customer"],
    values: [null, true, false, 0, -0, 1.25, 1e100, "-0", "漢字😀\u0000\"\\\n", []] };
  const encoded = encodeBoundedJsonStorage(original); assert(encoded, "Standard JSON values rejected");
  const decoded = decodeBoundedJsonStorage(JSON.parse(JSON.stringify(encoded)));
  assert(decoded.ok && same(decoded.value, original), "Array order/null/numbers/booleans/strings changed");
  const repeatedStringNodes = encoded.nodes.filter(node => node[0] === 3 && node[1] === "customer");
  assert(repeatedStringNodes.length === 1, "Repeated key/string did not share one node");
  const copy = decoded.value;
  assert(copy !== null && typeof copy === "object" && !Array.isArray(copy), "Decoded root is not an object");
  assert(copy.before !== copy.after, "Structural interning leaked shared mutable object identity");
  const before = copy.before;
  assert(before !== null && typeof before === "object" && !Array.isArray(before), "Decoded before missing");
  before.revision = 999;
  const after = copy.after;
  assert(after !== null && typeof after === "object" && !Array.isArray(after) && after.revision === 42,
    "Editing one decoded occurrence rewrote the other canonical state");
});

Deno.test("P1 bounded JSON: object order is deterministic but array order remains significant", () => {
  const a = encodeBoundedJsonStorage({ z: { beta: 2, alpha: 1 }, a: [3, 1, 2] });
  const b = encodeBoundedJsonStorage({ a: [3, 1, 2], z: { alpha: 1, beta: 2 } });
  assert(a && b && JSON.stringify(a) === JSON.stringify(b), "Object insertion order changed deterministic storage");
  const c = encodeBoundedJsonStorage({ a: [1, 2, 3], z: { alpha: 1, beta: 2 } });
  assert(c && JSON.stringify(a) !== JSON.stringify(c), "Array order was collapsed");
});

Deno.test("P1 bounded JSON: valid null and negative zero remain distinguishable from failure", () => {
  for (const value of [null, -0]) {
    const encoded = encodeBoundedJsonStorage(value); assert(encoded, "JSON scalar rejected");
    const result = decodeBoundedJsonStorage(JSON.parse(JSON.stringify(encoded)));
    assert(result.ok && Object.is(result.value, value), "Scalar identity changed or valid null treated as rejection");
  }
});

Deno.test("P1 bounded JSON: prototype-looking customer keys remain ordinary own data", () => {
  const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":"customer-key","prototype":null}');
  const encoded = encodeBoundedJsonStorage(value); assert(encoded, "Valid JSON keys rejected");
  const result = decodeBoundedJsonStorage(encoded);
  assert(result.ok && same(result.value, value) && Object.getPrototypeOf(result.value) === Object.prototype,
    "Object keys changed the decoded prototype");
  assert(!Object.hasOwn(Object.prototype, "polluted"), "Decoder polluted Object.prototype");
});

Deno.test("P1 bounded JSON: exact encoded character limit is enforced without a raised budget", () => {
  const base = encodeBoundedJsonStorage(""); assert(base, "Empty string rejected");
  const length = BOUNDED_JSON_STORAGE_LIMITS.encodedCharacters - JSON.stringify(base).length;
  const atLimit = encodeBoundedJsonStorage("x".repeat(length));
  assert(atLimit && JSON.stringify(atLimit).length === 16_384 && decodeBoundedJsonStorage(atLimit).ok,
    "Exact encoded character boundary rejected");
  assert(encodeBoundedJsonStorage("x".repeat(length + 1)) === null, "Oversized encoded root accepted");
  const over = structuredClone(atLimit); const string = over.nodes[0]; assert(string[0] === 3, "String node missing"); string[1] += "x";
  assert(!decodeBoundedJsonStorage(over).ok, "Decoder ignored envelope overhead at encoded boundary");
});

Deno.test("P1 bounded JSON: expansion and nesting budgets are checked independently of compressed size", () => {
  const within = Array.from({ length: 506 }, () => "x".repeat(256));
  const encoded = encodeBoundedJsonStorage(within);
  assert(encoded && JSON.stringify(within).length <= 131_072 && decodeBoundedJsonStorage(encoded).ok, "Bounded repeated value rejected");
  assert(encodeBoundedJsonStorage([...within, within[0]]) === null, "Expanded root over 131072 accepted");
  let root: BoundedJsonValue = 0;
  for (let i = 0; i < 64; i++) root = [root];
  const depth64 = encodeBoundedJsonStorage(root);
  assert(depth64 && decodeBoundedJsonStorage(depth64).ok, "Depth64 boundary rejected");
  assert(encodeBoundedJsonStorage([root]) === null, "Depth65 accepted");
});

const malicious: Array<[string, () => unknown]> = [
  ["wrong-version", () => ({ ...envelope([[0]]), version: "other" })],
  ["extra-envelope-key", () => ({ ...envelope([[0]]), extra: true })],
  ["missing-root", () => ({ version: "bounded-json-storage-1", nodes: [[0]] })],
  ["root-not-last", () => envelope([[0], [1, true]], 0)],
  ["empty-table", () => envelope([], -1)],
  ["unknown-tag", () => envelope([[9, 0]])],
  ["extra-node-field", () => envelope([[0, 1]])],
  ["wrong-scalar-type", () => envelope([[1, "true"]])],
  ["nonfinite-number", () => envelope([[2, Infinity]])],
  ["invalid-number-string", () => envelope([[2, "123"]])],
  ["forward-reference", () => envelope([[4, [1]], [0]])],
  ["self-cycle", () => envelope([[4, [0]]])],
  ["mutual-cycle", () => envelope([[4, [1]], [4, [0]]])],
  ["negative-reference", () => envelope([[0], [4, [-1]]])],
  ["fractional-reference", () => envelope([[0], [4, [0.5]]])],
  ["string-reference", () => envelope([[0], [4, ["0"]]])],
  ["nonstring-object-key", () => envelope([[0], [5, [[0, 0]]]])],
  ["duplicate-object-key", () => envelope([[3, "same"], [3, "same"], [0], [5, [[0, 2], [1, 2]]]])],
  ["wrong-object-pair-shape", () => envelope([[3, "key"], [0], [5, [[0, 1, 1]]]])],
  ["node-count-overflow", () => envelope(Array.from({ length: 4097 }, () => [0]))],
  ["escaped-character-overflow", () => envelope([[3, "\n".repeat(9000)]])],
  ["expansion-bomb", () => { const nodes: unknown[] = [[3, "x"]]; for (let i = 0; i < 15; i++) nodes.push([4, [i, i]]); return envelope(nodes); }],
  ["depth-overflow", () => { const nodes: unknown[] = [[0]]; for (let i = 0; i < 65; i++) nodes.push([4, [i]]); return envelope(nodes); }],
  ["sparse-node-table", () => envelope(new Array(2))],
  ["custom-array-prototype", () => { const nodes = [[0]]; Object.setPrototypeOf(nodes, { toJSON: () => [] }); return envelope(nodes); }],
];
for (const [label, value] of malicious) Deno.test(`P1 bounded JSON decoder negative: ${label}`, () => {
  assert(!decodeBoundedJsonStorage(value()).ok, "Malformed or oversized encoding accepted: " + label);
});

for (const [label, value] of [
  ["undefined", undefined], ["nonfinite", NaN], ["bigint", 1n], ["function", () => 1],
  ["symbol", Symbol("value")], ["date", new Date(0)], ["sparse-array", new Array(1)],
  ["undefined-property", { value: undefined }], ["accessor", Object.defineProperty({}, "value", { enumerable: true, get() { throw new Error("Getter must not run"); } })],
] as const) Deno.test(`P1 bounded JSON encoder negative: ${label}`, () => {
  assert(encodeBoundedJsonStorage(value) === null, "Non-JSON value was silently transformed: " + label);
});

Deno.test("P1 bounded JSON encoder negative: cyclic object and array are rejected", () => {
  const object: Record<string, unknown> = {}; object.self = object;
  const array: unknown[] = []; array.push(array);
  assert(encodeBoundedJsonStorage(object) === null && encodeBoundedJsonStorage(array) === null,
    "Cycle was encoded or silently truncated");
});
