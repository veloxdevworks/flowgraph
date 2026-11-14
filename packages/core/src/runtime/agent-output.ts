import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

const validators = new WeakMap<object, ValidateFunction>();

/** Validate without coercion, default insertion, or dropping unexpected fields. */
export function validateAgentOutput(
  output: unknown,
  schema: Record<string, unknown> | undefined,
  label: string,
): void {
  if (!schema) return;
  let validate = validators.get(schema);
  if (!validate) {
    try {
      const ajv = new Ajv({ allErrors: true, strictTypes: false, allowUnionTypes: true });
      addFormats.default(ajv);
      validate = ajv.compile(schema);
      validators.set(schema, validate);
    } catch (cause) {
      throw Object.assign(
        new Error(`${label}: invalid output schema: ${String(cause)}`, { cause }),
        { code: "AGENT_SCHEMA_INVALID", retryable: false },
      );
    }
  }
  if (!validate(output)) {
    const errors = validate.errors?.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    throw Object.assign(new Error(`${label}: output does not match schema: ${errors}`), {
      code: "AGENT_OUTPUT_INVALID",
      retryable: false,
    });
  }
}
