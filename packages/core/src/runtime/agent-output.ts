import { ContractSchemaError, contractErrors } from "@flowgraph/spec";

/**
 * Validate agent output against `with.schema` with the shared contract validator
 * (JSON Schema draft-07 via Ajv): no coercion, default insertion, or dropping fields.
 */
export function validateAgentOutput(
  output: unknown,
  schema: Record<string, unknown> | undefined,
  label: string,
): void {
  if (!schema) return;
  let errors: string | undefined;
  try {
    errors = contractErrors(output, schema);
  } catch (cause) {
    if (!(cause instanceof ContractSchemaError)) throw cause;
    throw Object.assign(
      new Error(`${label}: invalid output schema: ${cause.message}`, { cause }),
      { code: "AGENT_SCHEMA_INVALID", retryable: false },
    );
  }
  if (errors) {
    throw Object.assign(new Error(`${label}: output does not match schema: ${errors}`), {
      code: "AGENT_OUTPUT_INVALID",
      retryable: false,
    });
  }
}
