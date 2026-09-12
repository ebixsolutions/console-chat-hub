export type IndustryFieldType = "string" | "number" | "boolean" | "object";

export interface IndustrySchemaField {
  key: string;
  type: IndustryFieldType;
  required: boolean;
  description: string;
}

export interface IndustrySchema {
  id: string;
  version: string;
  fields: readonly IndustrySchemaField[];
}

export interface IndustrySchemaValidation {
  valid: boolean;
  errors: string[];
}

const IDENTIFIER = /^[a-z][a-z0-9_]{1,63}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const FIELD_TYPES = new Set<IndustryFieldType>(["string", "number", "boolean", "object"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateIndustrySchema(schema: IndustrySchema): IndustrySchemaValidation {
  const errors: string[] = [];
  if (!IDENTIFIER.test(schema.id)) errors.push("invalid_schema_id");
  if (!VERSION.test(schema.version)) errors.push("invalid_schema_version");
  if (!Array.isArray(schema.fields) || schema.fields.length === 0)
    errors.push("empty_schema_fields");
  const seen = new Set<string>();
  for (const field of schema.fields ?? []) {
    if (!IDENTIFIER.test(field.key)) errors.push(`invalid_field_key:${field.key}`);
    if (seen.has(field.key)) errors.push(`duplicate_field_key:${field.key}`);
    seen.add(field.key);
    if (!FIELD_TYPES.has(field.type)) errors.push(`invalid_field_type:${field.key}`);
    if (typeof field.required !== "boolean") errors.push(`invalid_field_required:${field.key}`);
    if (!field.description.trim()) errors.push(`missing_field_description:${field.key}`);
  }
  return { valid: errors.length === 0, errors };
}

export function validateIndustrySchemaValues(
  schema: IndustrySchema,
  value: unknown,
): IndustrySchemaValidation {
  const definition = validateIndustrySchema(schema);
  if (!definition.valid) return definition;
  if (!isRecord(value)) return { valid: false, errors: ["industry_values_not_object"] };
  const errors: string[] = [];
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(value)) if (!fields.has(key)) errors.push(`unknown_field:${key}`);
  for (const field of schema.fields) {
    const fieldValue = value[field.key];
    if (fieldValue === undefined || fieldValue === null) {
      if (field.required) errors.push(`missing_required_field:${field.key}`);
      continue;
    }
    const matches =
      field.type === "object" ? isRecord(fieldValue) : typeof fieldValue === field.type;
    if (!matches || (field.type === "number" && !Number.isFinite(fieldValue))) {
      errors.push(`invalid_field_value:${field.key}`);
    }
  }
  return { valid: errors.length === 0, errors };
}
