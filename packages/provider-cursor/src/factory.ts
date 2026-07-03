/**
 * Build a Cursor provider from declarative provider config (YAML `providers` block).
 */

import type { ProviderAdapter } from "@veloxdevworks/flowgraph-core";
import type { CursorProviderConfig } from "@veloxdevworks/flowgraph-spec";
import { createCursorProvider, type CursorRuntime } from "./provider.js";

const DEFAULT_API_KEY_ENV = "CURSOR_API_KEY";

function readEnvKey(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return raw.trim();
}

export interface CursorProviderFromConfigOptions {
  cwd?: string;
}

export async function createCursorProviderFromConfig(
  name: string,
  cfg: CursorProviderConfig,
  options: CursorProviderFromConfigOptions = {},
): Promise<ProviderAdapter> {
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
    ...(cfg.model ? { model: cfg.model, models: [cfg.model] } : {}),
    ...(cfg.options ?? {}),
  });
}
