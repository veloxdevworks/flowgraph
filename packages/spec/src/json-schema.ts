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
