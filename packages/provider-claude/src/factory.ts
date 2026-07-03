/**
 * Build a Claude provider from declarative provider config (YAML `providers` block).
 */

import type { ProviderAdapter } from "@veloxdevworks/flowgraph-core";
import type { ClaudeProviderConfig } from "@veloxdevworks/flowgraph-spec";
import { createClaudeProvider, type ClaudePermissionMode } from "./provider.js";

const DEFAULT_API_KEY_ENV = "ANTHROPIC_API_KEY";

function readEnvKey(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return raw.trim();
}

export interface ClaudeProviderFromConfigOptions {
  cwd?: string;
}

export async function createClaudeProviderFromConfig(
  name: string,
  cfg: ClaudeProviderConfig,
  options: ClaudeProviderFromConfigOptions = {},
): Promise<ProviderAdapter> {
  const apiKeyEnv = cfg.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const apiKey = readEnvKey(apiKeyEnv);
  if (!apiKey) {
    throw new Error(
      `Missing API key for Claude provider "${name}". Set environment variable ${apiKeyEnv}.`,
    );
  }

  const cwd = cfg.cwd ?? options.cwd ?? process.cwd();
  const providerOpts = {
    name,
    apiKey,
    cwd,
    ...(cfg.model ? { model: cfg.model, models: [cfg.model] } : {}),
    ...(cfg.permissionMode ? { permissionMode: cfg.permissionMode as ClaudePermissionMode } : {}),
    ...(cfg.options ?? {}),
  };

  return createClaudeProvider(providerOpts);
}
