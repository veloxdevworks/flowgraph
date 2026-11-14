import type { TokenUsage } from "../providers/types.js";

/** Only for one actual model request, never an opaque multi-call SDK operation. */
export function rejectedRequestUsage(error: unknown): TokenUsage | undefined {
  let value = error;
  for (let depth = 0; depth < 5 && value && typeof value === "object"; depth++) {
    const fields = value as { code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
    const status = Number(fields.status ?? fields.statusCode);
    if ([401, 403, 429].includes(status) || ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(String(fields.code))) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 };
    }
    value = fields.cause;
  }
  // Connection resets, timeouts, aborts and 5xx can follow acceptance/billing.
  return undefined;
}
