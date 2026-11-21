import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { GraphSpecSchema } from "./schema.js";

/**
 * Generate a JSON Schema document for the Graph spec.
 * Used for editor autocomplete/validation (e.g. yaml-language-server).
 */
export function generateJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(GraphSpecSchema, {
    name: "GraphSpec",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  omitRunsOnWait(schema);
  markBarrierFromUnique(schema);
  return schema;
}

/**
 * `runsOn.wait` is rejected by the Zod schema, but a `z.any()` placeholder
 * would still appear in the generated JSON Schema as `{}` and show up in
 * editors. Drop the property so editors do not offer it.
 */
function omitRunsOnWait(node: unknown): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) omitRunsOnWait(item);
    return;
  }
  const rec = node as Record<string, unknown>;
  const props = rec.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const fields = props as Record<string, unknown>;
    if ("labels" in fields && "fallback" in fields && "wait" in fields) {
      delete fields.wait;
      if (Array.isArray(rec.required)) {
        rec.required = rec.required.filter((key) => key !== "wait");
      }
    }
  }
  for (const value of Object.values(rec)) omitRunsOnWait(value);
}

/**
 * The list form of an edge `from` is a barrier. Zod records `minItems` but
 * not `uniqueItems`; editors should still reject repeated ids.
 */
function markBarrierFromUnique(node: unknown): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) markBarrierFromUnique(item);
    return;
  }
  const rec = node as Record<string, unknown>;
  const props = rec.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const from = (props as Record<string, unknown>).from;
    if (from) markFromArrayUnique(from);
  }
  for (const value of Object.values(rec)) markBarrierFromUnique(value);
}

function markFromArrayUnique(schema: unknown): void {
  if (schema == null || typeof schema !== "object") return;
  const rec = schema as Record<string, unknown>;
  if (rec.type === "array") {
    rec.uniqueItems = true;
    return;
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = rec[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) markFromArrayUnique(branch);
  }
}

/**
 * JSON Schema for one node type's `with` block (used by UIs to render a
 * generic inspector for plugin node types).
 */
export function zodToConfigJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as Record<
    string,
    unknown
  >;
}
