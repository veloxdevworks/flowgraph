/**
 * Build a Cursor provider from declarative provider config (YAML `providers` block).
 */

import { assertSecretDeclared, currentEnvironment, type ProviderAdapter } from "@flowgraph/core";
import type { CursorProviderConfig } from "@flowgraph/spec";
import { createCursorProvider, type CursorRuntime } from "./provider.js";

const DEFAULT_API_KEY_ENV = "CURSOR_API_KEY";

function readEnvKey(name: string): string | undefined {
  const raw = currentEnvironment()[name];
  if (raw === undefined || raw === "") return undefined;
  return raw.trim();
}

export interface CursorProviderFromConfigOptions {
  cwd?: string;
  /** The graph's top-level `secrets:`. An explicit `apiKeyEnv` is read only when it is listed here. */
  secrets?: readonly string[] | undefined;
}

export async function createCursorProviderFromConfig(
  name: string,
  cfg: CursorProviderConfig,
  options: CursorProviderFromConfigOptions = {},
): Promise<ProviderAdapter> {
  if (cfg.apiKeyEnv !== undefined) {
    assertSecretDeclared(new Set(options.secrets ?? []), cfg.apiKeyEnv, `Provider "${name}" apiKeyEnv`);
  }
  const apiKeyEnv = cfg.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const apiKey = readEnvKey(apiKeyEnv);
  if (!apiKey) {
    throw new Error(
      `Missing API key for Cursor provider "${name}". Set environment variable ${apiKeyEnv}.`,
    );
  }

  const cwd = options.cwd ?? process.cwd();
  return createCursorProvider({
    name,
    apiKey,
    cwd,
    runtime: (cfg.runtime ?? "local") as CursorRuntime,
    apiKeyEnv,
    ...(cfg.model ? { model: cfg.model } : {}),
    ...(cfg.options ?? {}),
  });
}
