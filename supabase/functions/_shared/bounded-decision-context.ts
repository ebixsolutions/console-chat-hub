/** Read-only customer requirements, never instructions or merchant authority. */
export type DecisionValue = string | number | boolean | null | DecisionValue[] | { [key: string]: DecisionValue };
export const DECISION_CONTEXT_LIMITS = Object.freeze({ depth: 3, fields: 40, items: 12, leaves: 96, text: 300 });
export type DecisionContextLimitDiagnostic = {
  code: "depth" | "fields" | "items" | "leaves" | "text_length" | "key_length" | "cycle";
  data_type: "null" | "array" | "object" | "string" | "number" | "boolean" | "undefined";
  depth: number;
  actual: number;
  limit: number;
};
export class DecisionContextLimitError extends Error {
  readonly diagnostic?: DecisionContextLimitDiagnostic;
  constructor(diagnostic?: DecisionContextLimitDiagnostic) {
    super("decision_context_limit"); this.name = "DecisionContextLimitError";
    this.diagnostic = diagnostic;
  }
}
const privateKey = /(?:^|_)(?:password|secret|token|jwt|authorization|cookie|credential|session|email|phone|user_id|street_address)(?:_|$)/i;
const clean = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();

export function normalizeDecisionContext(value: unknown): Record<string, DecisionValue> {
  let leaves = 0;
  const ancestors = new Set<object>();
  function visit(v: unknown, depth: number): DecisionValue | undefined {
    const fail = (code: DecisionContextLimitDiagnostic["code"], actual: number, limit: number): never => {
      const data_type = (v === null ? "null" : Array.isArray(v) ? "array" : typeof v) as DecisionContextLimitDiagnostic["data_type"];
      throw new DecisionContextLimitError({code, data_type, depth, actual, limit});
    };
    if (depth > DECISION_CONTEXT_LIMITS.depth) fail("depth", depth, DECISION_CONTEXT_LIMITS.depth);
    if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
      if (++leaves > DECISION_CONTEXT_LIMITS.leaves) fail("leaves", leaves, DECISION_CONTEXT_LIMITS.leaves);
      if (typeof v === "number" && !Number.isFinite(v)) return undefined;
      if (typeof v === "string") {
        const text = clean(v);
        if (text.length > DECISION_CONTEXT_LIMITS.text) fail("text_length", text.length, DECISION_CONTEXT_LIMITS.text);
        // Do not forward accidental credential material, even under an innocuous key.
        if (/\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(text)) return undefined;
        return text;
      }
      // Keep the validated primitive result narrow with or without strictNullChecks.
      return typeof v === "boolean" || typeof v === "number" ? v : null;
    }
    if (!v || typeof v !== "object") return undefined;
    if (ancestors.has(v)) fail("cycle", 1, 0);
    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        if (v.length > DECISION_CONTEXT_LIMITS.items) fail("items", v.length, DECISION_CONTEXT_LIMITS.items);
        const items: DecisionValue[] = [];
        for (const item of v) { const normalized = visit(item, depth + 1); if (normalized !== undefined) items.push(normalized); }
        return items;
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return undefined;
      const keys = Object.keys(v).filter(k => !privateKey.test(clean(k)) && !["__proto__", "prototype", "constructor"].includes(clean(k))).sort();
      if (keys.length > DECISION_CONTEXT_LIMITS.fields) fail("fields", keys.length, DECISION_CONTEXT_LIMITS.fields);
      const out: Record<string, DecisionValue> = {};
      for (const key of keys) {
        const name = clean(key);
        if (!name) fail("key_length", 0, 1);
        if (name.length > 80) fail("key_length", name.length, 80);
        const item = visit((v as Record<string, unknown>)[key], depth + 1);
        if (item !== undefined) out[name] = item;
      }
      return out;
    } finally { ancestors.delete(v); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return visit(value, 0) as Record<string, DecisionValue>;
}

/** Finite schema: leaves and at most two additional container levels. */
export function decisionContextSchema(depth = 2): Record<string, unknown> {
  const scalar = { type: ["string", "number", "boolean", "null"] };
  if (!depth) return scalar;
  const child = decisionContextSchema(depth - 1);
  return { anyOf: [scalar, { type: "array", items: child, maxItems: 12 },
    { type: "object", additionalProperties: child }] };
}

/** Latest explicit value wins; absent fields retain active customer requirements. */
export function mergeDecisionContext(prior: unknown, current: unknown): Record<string, DecisionValue> {
  const a = normalizeDecisionContext(prior), b = normalizeDecisionContext(current);
  const merge = (old: Record<string, DecisionValue>, next: Record<string, DecisionValue>): Record<string, DecisionValue> => {
    const out = { ...old };
    for (const [key,value] of Object.entries(next)) {
      const previous = old[key];
      out[key] = value && typeof value === "object" && !Array.isArray(value) && previous && typeof previous === "object" && !Array.isArray(previous)
        ? merge(previous, value) : value;
    }
    return out;
  };
  return normalizeDecisionContext(merge(a,b));
}
