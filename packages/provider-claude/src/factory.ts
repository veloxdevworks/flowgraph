/**
 * Build a Claude provider from declarative provider config (YAML `providers` block).
 */

import { assertSecretDeclared, currentEnvironment, type ProviderAdapter } from "@flowgraph/core";
import type { ClaudeProviderConfig } from "@flowgraph/spec";
import { createClaudeProvider, type ClaudePermissionMode } from "./provider.js";

const DEFAULT_API_KEY_ENV = "ANTHROPIC_API_KEY";

function readEnvKey(name: string): string | undefined {
  const raw = currentEnvironment()[name];
  if (raw === undefined || raw === "") return undefined;
  return raw.trim();
}

export interface ClaudeProviderFromConfigOptions {
  cwd?: string;
  /** The graph's top-level `secrets:`. An explicit `apiKeyEnv` is read only when it is listed here. */
  secrets?: readonly string[] | undefined;
}

export async function createClaudeProviderFromConfig(
  name: string,
  cfg: ClaudeProviderConfig,
  options: ClaudeProviderFromConfigOptions = {},
): Promise<ProviderAdapter> {
  if (cfg.apiKeyEnv !== undefined) {
    assertSecretDeclared(new Set(options.secrets ?? []), cfg.apiKeyEnv, `Provider "${name}" apiKeyEnv`);
  }
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
    apiKeyEnv,
    ...(cfg.model ? { model: cfg.model } : {}),
    ...(cfg.permissionMode ? { permissionMode: cfg.permissionMode as ClaudePermissionMode } : {}),
    ...(cfg.options ?? {}),
  };

  return createClaudeProvider(providerOpts);
}
