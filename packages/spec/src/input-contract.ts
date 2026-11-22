/**
 * The check a declared run parameter applies to a value. Shared by the engine (when a run starts
 * and at a subgraph call), the validator (for a `default`) and clients that mirror the rule.
 * It never coerces: a value is valid as it is, or it is not.
 */

import { contractErrors } from "./validate-json-schema.js";

export type InputValueField = {
  type?: "string" | "number" | "boolean" | "select" | "json" | undefined;
  options?: readonly string[] | undefined;
  schema?: Record<string, unknown> | undefined;
};

/** Why `value` is not valid for the field, or `undefined` when it is. */
export function inputValueProblem(field: InputValueField, value: unknown): string | undefined {
  switch (field.type ?? "string") {
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : "expected a number";
    case "boolean":
      return typeof value === "boolean" ? undefined : "expected a boolean";
    case "select": {
      const options = field.options ?? [];
      return typeof value === "string" && options.includes(value)
        ? undefined
        : `must be one of: ${options.join(", ") || "(none)"}`;
    }
    case "json": {
      if (!field.schema) return undefined;
      const problems = contractErrors(value, field.schema);
      return problems ? `does not match schema: ${problems}` : undefined;
    }
    default:
      return typeof value === "string" ? undefined : "expected a string";
  }
}
