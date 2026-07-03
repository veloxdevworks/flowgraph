/**
 * Secret providers and event/log redaction.
 *
 * Providers:
 *   - env      — reads from process.env (default)
 *   - dotenv   — loads a .env file then delegates to env
 *
 * Redaction:
 *   - createRedactor() — returns a function that masks secrets in any string/object
 *   - RedactingSink   — wraps an EventSink, redacting event data before forwarding
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { EventSink, FlowgraphEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Secret Provider interface (re-exported for convenience)
// ---------------------------------------------------------------------------

export interface SecretProvider {
  get(name: string): Promise<string | undefined>;
  has(name: string): boolean;
}

export function createEnvSecretProvider(env: NodeJS.ProcessEnv = process.env): SecretProvider {
  return {
    get: async (name) => env[name],
    has: (name) => name in env,
  };
}

export function createDotenvSecretProvider(
  dotenvPath?: string,
  fallback: NodeJS.ProcessEnv = process.env,
): SecretProvider {
  const resolved = dotenvPath ?? path.resolve(process.cwd(), ".env");
  const parsed: Record<string, string> = {};

  try {
    const raw = fs.readFileSync(resolved, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      parsed[key] = val;
    }
  } catch {
    // File not found is fine — fall back to process.env only
  }

  const merged = { ...parsed, ...fallback };

  return {
    get: async (name) => merged[name],
    has: (name) => name in merged,
  };
}

// ---------------------------------------------------------------------------
// Redactor
// ---------------------------------------------------------------------------

export type Redactor = (value: unknown) => unknown;

const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Create a redactor that replaces known secret values anywhere they appear
 * in strings or nested objects/arrays.
 *
 * @param secrets — list of sensitive strings to redact
 * @param patterns — additional regex patterns to redact
 */
export function createRedactor(
  secrets: string[],
  patterns: RegExp[] = [],
): Redactor {
  // Filter out empty/short secrets that would cause too many false positives
  const safeSecrets = secrets.filter((s) => s.length >= 6);

  return function redact(value: unknown): unknown {
    if (value == null) return value;

    if (typeof value === "string") {
      let result = value;
      for (const secret of safeSecrets) {
        if (result.includes(secret)) {
          result = result.replaceAll(secret, REDACTION_PLACEHOLDER);
        }
      }
      for (const pattern of patterns) {
        result = result.replace(pattern, REDACTION_PLACEHOLDER);
      }
      return result;
    }

    if (Array.isArray(value)) {
      return value.map(redact);
    }

    if (typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = redact(v);
      }
      return result;
    }

    return value;
  };
}

/**
 * Common regex patterns for secrets that appear in structured values
 * even when we don't know the exact value.
 */
export const DEFAULT_REDACT_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  /token["\s:=]+["']?[A-Za-z0-9\-._~+/]{20,}["']?/gi,
  /api[_-]?key["\s:=]+["']?[A-Za-z0-9\-._~+/]{20,}["']?/gi,
  /password["\s:=]+["']?[^\s"']{8,}["']?/gi,
];

// ---------------------------------------------------------------------------
// Redacting event sink wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps any EventSink and runs the redactor over each event's `data` field
 * before passing it downstream. The original event object is not mutated.
 */
export function redactingSink(inner: EventSink, redact: Redactor): EventSink {
  return (event: FlowgraphEvent): void | Promise<void> => {
    const redacted: FlowgraphEvent = {
      ...event,
      data: redact(event.data),
    };
    return inner(redacted);
  };
}

/**
 * Build a complete secret + redaction setup from an env config.
 * Returns a provider and a ready-to-use redacting sink wrapper factory.
 */
export async function createSecretSetup(opts: {
  provider?: "env" | "dotenv" | string;
  dotenvPath?: string;
  redactPatterns?: string[];
  redactHeaders?: string[];
}): Promise<{
  secrets: SecretProvider;
  wrapSink: (inner: EventSink) => EventSink;
}> {
  const provider =
    opts.provider === "dotenv"
      ? createDotenvSecretProvider(opts.dotenvPath)
      : createEnvSecretProvider();

  // Collect values of known secret vars to redact
  const secretValues: string[] = [];
  // We don't know all secret names here, so rely on patterns
  const patterns: RegExp[] = [...DEFAULT_REDACT_PATTERNS];

  if (opts.redactPatterns) {
    for (const p of opts.redactPatterns) {
      try { patterns.push(new RegExp(p, "gi")); } catch { /* ignore invalid regex */ }
    }
  }

  const redact = createRedactor(secretValues, patterns);
  const wrapSink = (inner: EventSink) => redactingSink(inner, redact);

  return { secrets: provider, wrapSink };
}
