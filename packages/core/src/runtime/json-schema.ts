/**
 * Lightweight JSON Schema checks used by hitl `form` / wait webhook resume.
 * Validates `required` keys and primitive `properties.*.type`. Not a full draft-07 engine.
 */

export function validateJsonSchema(
  payload: unknown,
  schema: Record<string, unknown> | undefined,
  label: string,
): void {
  if (!schema) return;
  const obj =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  if (!obj) {
    throw new Error(`${label}: resume payload must be an object.`);
  }

  const required = schema["required"];
  if (Array.isArray(required)) {
    const missing = (required as string[]).filter((key) => obj[key] === undefined);
    if (missing.length > 0) {
      throw new Error(`${label}: missing required field(s): ${missing.join(", ")}`);
    }
  }

  const props = schema["properties"];
  if (!props || typeof props !== "object" || Array.isArray(props)) return;
  for (const [key, def] of Object.entries(props as Record<string, { type?: string }>)) {
    if (obj[key] === undefined || def?.type == null) continue;
    if (!matchesJsonType(obj[key], def.type)) {
      throw new Error(`${label}: field "${key}" expected type ${def.type}.`);
    }
  }
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
    case "integer":
      return typeof value === "number" && (type === "number" || Number.isInteger(value));
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value != null && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}
