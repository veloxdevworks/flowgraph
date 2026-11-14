import type { ProviderAdapter } from "./types.js";
import { createRedactor, DEFAULT_REDACT_PATTERNS } from "../secrets.js";
import { isGraphInterrupt } from "./replay-cache.js";

/** Redact before errors reach node hooks, events, loggers, or RunResult. */
export function redactProviderErrors(provider: ProviderAdapter): ProviderAdapter {
  const run = provider.run.bind(provider);
  return {
    ...provider,
    async run(req, ctx) {
      try {
        return await run(req, ctx);
      } catch (error) {
        if (isGraphInterrupt(error)) throw error;
        const values = Object.entries(process.env)
          .filter(([name]) => /key|token|secret|password|credential/i.test(name))
          .flatMap(([, value]) => (value ? [value] : []));
        const redact = createRedactor(values, DEFAULT_REDACT_PATTERNS);
        const seen = new Set<Error>();
        const clean = (value: unknown): unknown => {
          if (!(value instanceof Error)) return redact(value);
          if (seen.has(value)) return undefined;
          seen.add(value);
          value.message = String(redact(value.message));
          if (value.stack) value.stack = String(redact(value.stack));
          if (value.cause !== undefined) value.cause = clean(value.cause);
          return value;
        };
        throw clean(error);
      }
    },
  };
}
