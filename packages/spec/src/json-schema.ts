import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { GraphSpecSchema } from "./schema.js";

/**
 * Generate a JSON Schema document for the Graph spec.
 * Used for editor autocomplete/validation (e.g. yaml-language-server).
 */
export function generateJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(GraphSpecSchema, {
    name: "GraphSpec",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

/**
 * JSON Schema for one node type's `with` block (used by UIs to render a
 * generic inspector for plugin node types).
 */
export function zodToConfigJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as Record<string, unknown>;
}
