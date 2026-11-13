import { validateJsonSchema } from "./json-schema.js";

/** Keep HTTP preflight and the wait node's replay validation identical. */
export function parseWebhookPayload(
  payload: unknown,
  schema: Record<string, unknown> | undefined,
  nodeId: string,
): Record<string, unknown> {
  const result =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { value: payload };
  validateJsonSchema(result, schema, `wait node "${nodeId}"`);
  return result;
}
