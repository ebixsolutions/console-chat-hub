/** Pure request validation; no credentials, prompts or transport side effects. */
export class VertexRequestValidationError extends Error {
  constructor(public readonly reason: string) { super(reason); this.name = "VertexRequestValidationError"; }
}
const invalid = (reason: string): never => { throw new VertexRequestValidationError(reason); };

/** Serialize the documented OpenAPI subset; fail rather than silently dropping
 * constraints. Canonical semantic validation is independently applied to output. */
export function normalizeVertexResponseSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const visit = (raw: unknown, depth: number): Record<string, unknown> => {
    if (depth > 16 || !raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("vertex_schema_node_invalid");
    const node = raw as Record<string, unknown>;
    const allowed = new Set(["type", "nullable", "properties", "items", "required", "enum", "minimum", "maximum", "minItems", "maxItems", "description", "format", "propertyOrdering", "anyOf"]);
    if (Object.keys(node).some(k => !allowed.has(k))) return invalid("vertex_schema_field_unsupported");
    const type = typeof node.type === "string" ? node.type.toUpperCase() : "";
    if (type && !["OBJECT", "ARRAY", "STRING", "NUMBER", "INTEGER", "BOOLEAN", "NULL"].includes(type)) return invalid("vertex_schema_type_invalid");
    if (!type && !Array.isArray(node.anyOf)) return invalid("vertex_schema_type_required");
    const out: Record<string, unknown> = { ...node, ...(type ? { type } : {}) };
    if (node.nullable !== undefined && typeof node.nullable !== "boolean") return invalid("vertex_schema_nullable_invalid");
    if (node.properties !== undefined) {
      if (type !== "OBJECT" || !node.properties || typeof node.properties !== "object" || Array.isArray(node.properties)) return invalid("vertex_schema_properties_invalid");
      out.properties = Object.fromEntries(Object.entries(node.properties).map(([k,v]) => [k,visit(v,depth+1)]));
    }
    for (const key of ["required", "propertyOrdering"]) if (node[key] !== undefined) {
      const keys = node[key];
      if (!Array.isArray(keys) || keys.some(k => typeof k !== "string" || !Object.hasOwn((out.properties ?? {}) as object,k)) || new Set(keys).size !== keys.length) return invalid("vertex_schema_property_reference_invalid");
    }
    if (node.enum !== undefined && (type !== "STRING" || !Array.isArray(node.enum) || !node.enum.length || node.enum.some(x => typeof x !== "string"))) return invalid("vertex_schema_enum_invalid");
    if (type === "ARRAY" && node.items === undefined) return invalid("vertex_schema_items_required");
    if (node.items !== undefined) out.items = visit(node.items,depth+1);
    if (node.anyOf !== undefined) {
      if (!Array.isArray(node.anyOf) || !node.anyOf.length) return invalid("vertex_schema_anyof_invalid");
      out.anyOf = node.anyOf.map(x => visit(x,depth+1));
    }
    for (const key of ["maxItems", "minItems"]) if (node[key] !== undefined) {
      const value = Number(node[key]);
      if (!Number.isSafeInteger(value) || value < 0 || type !== "ARRAY") return invalid("vertex_schema_array_bound_invalid");
      out[key] = String(value); // protobuf int64 JSON representation
    }
    for (const key of ["minimum", "maximum"]) if (node[key] !== undefined &&
      (typeof node[key] !== "number" || !Number.isFinite(node[key]) || !["NUMBER","INTEGER"].includes(type))) return invalid("vertex_schema_numeric_bound_invalid");
    return out;
  };
  return visit(schema,0);
}

export function buildVertexEndpoint(project: string, region: string, model: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(project) || !/^[a-z][a-z0-9-]*$/.test(region) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)) return invalid("vertex_endpoint_invalid");
  const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:generateContent`;
}

/** Structural receipt only; never a provider-acceptance assertion or a log of
 * schema field names/customer values. Useful for correlating compiler rejects. */
export function vertexResponseSchemaDiagnostic(schema: Record<string, unknown>): Record<string, number | string> {
  const normalized=normalizeVertexResponseSchema(schema);
  let objects=0,arrays=0,enumValues=0;
  const visit=(s:any)=>{if(s.type==="OBJECT")objects++;if(s.type==="ARRAY")arrays++;if(Array.isArray(s.enum))enumValues+=s.enum.length;
    if(s.properties)Object.values(s.properties).forEach(visit);if(s.items)visit(s.items);if(s.anyOf)s.anyOf.forEach(visit);};
  visit(normalized);
  return {schema_bytes:new TextEncoder().encode(JSON.stringify(normalized)).length,objects,arrays,enum_values:enumValues,
    transport:["semantic_paths_v2","semantic_fields_v3","semantic_values_v4","semantic_values_v5"].includes((normalized.properties as any)?.context_encoding?.enum?.[0])
      ? (normalized.properties as any).context_encoding.enum[0] : "other"};
}

export function buildVertexGenerationConfig(
  maxTokens: number, jsonOutput: boolean, responseSchema: Record<string, unknown> | undefined,
  thinkingBudget: number | undefined, model?: string,
): Record<string, unknown> {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) return invalid("vertex_max_tokens_invalid");
  if (responseSchema && !jsonOutput) return invalid("vertex_schema_requires_json");
  if (thinkingBudget !== undefined && (!Number.isInteger(thinkingBudget) || thinkingBudget < 0)) return invalid("vertex_thinking_budget_invalid");
  if (model && thinkingBudget !== undefined) {
    if (/^gemini-2\.5-flash(?:-|$)/.test(model)) {
      const min = /flash-lite/.test(model) ? 512 : 1;
      if (thinkingBudget > 24576 || (thinkingBudget > 0 && thinkingBudget < min)) return invalid("vertex_thinking_budget_model_invalid");
    } else if (/^gemini-2\.5-pro(?:-|$)/.test(model)) {
      if (thinkingBudget < 128 || thinkingBudget > 32768) return invalid("vertex_thinking_budget_model_invalid");
    } else return invalid("vertex_thinking_model_unsupported");
  }
  return {
    maxOutputTokens: maxTokens, temperature: 0,
    ...(thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget } } : {}),
    ...(jsonOutput ? { responseMimeType: "application/json" } : {}),
    ...(jsonOutput && responseSchema ? { responseSchema: normalizeVertexResponseSchema(responseSchema) } : {}),
  };
}

/** Provider text can echo prompts or secrets. Persist only enumerated classes
 * and safe field paths, never the message, request or credential values. */
export function safeVertexErrorDiagnostic(body: unknown): Record<string, unknown> {
  const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string,unknown> : {};
  const error = record(record(body).error);
  const status = ["INVALID_ARGUMENT", "NOT_FOUND", "PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "UNAVAILABLE", "INTERNAL", "UNAUTHENTICATED"].includes(String(error.status)) ? error.status : "UNKNOWN";
  const message = typeof error.message === "string" ? error.message : "";
  const cause = /(?:schema).*(?:complex|too many)|(?:complex|too many).*schema/i.test(message) ? "schema_complexity"
    : /response.?schema|generation.?config|thinking.?budget|thinking.?config/i.test(message) ? "generation_config"
    : /model.*(?:not found|not supported|not available)|location|region/i.test(message) ? "model_location"
    : "unknown";
  const fieldRoots = ["generation_config.response_schema", "generationConfig.responseSchema", "generation_config.thinking_config", "generationConfig.thinkingConfig", "generation_config", "generationConfig", "contents", "system_instruction", "systemInstruction"];
  const fields = (Array.isArray(error.details) ? error.details : []).flatMap(d => {
    const violations = record(d).fieldViolations;
    return (Array.isArray(violations) ? violations : []).flatMap(v => {
      const field = record(v).field;
      if (typeof field !== "string") return [];
      // Never persist dynamic property names echoed by the provider.
      const root = fieldRoots.find(k => field === k || field.startsWith(k + ".") || field.startsWith(k + "["));
      return root ? [root] : [];
    });
  }).slice(0,12);
  return { provider_status: status, provider_error_class: cause, provider_error_fields: fields };
}
