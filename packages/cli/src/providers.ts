/**
 * Build provider adapters from a graph spec's `providers` block.
 */

import type { ProviderAdapter } from "@veloxdevworks/flowgraph-core";
import {
  createLangChainProviderFromConfig,
  isKnownLangChainVendor,
} from "@veloxdevworks/flowgraph-core";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";

async function loadClaudeFactory() {
  try {
    const mod = await import("@veloxdevworks/flowgraph-provider-claude");
    return mod.createClaudeProviderFromConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find") || msg.includes("ERR_MODULE_NOT_FOUND")) {
      throw new Error(
        'Claude provider is not installed. Install it: pnpm add @veloxdevworks/flowgraph-provider-claude @anthropic-ai/claude-agent-sdk',
        { cause: err },
      );
    }
    throw err;
  }
}

async function loadCursorFactory() {
  try {
    const mod = await import("@veloxdevworks/flowgraph-provider-cursor");
    return mod.createCursorProviderFromConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find") || msg.includes("ERR_MODULE_NOT_FOUND")) {
      throw new Error(
        'Cursor provider is not installed. Install it: pnpm add @veloxdevworks/flowgraph-provider-cursor @cursor/sdk',
        { cause: err },
      );
    }
    throw err;
  }
}

export async function buildProviders(spec: GraphSpec, cwd = process.cwd()): Promise<ProviderAdapter[]> {
  const providers: ProviderAdapter[] = [];
  const built = new Set<string>();

  for (const [name, cfg] of Object.entries(spec.providers ?? {})) {
    switch (cfg.kind) {
      case "langchain":
        providers.push(await createLangChainProviderFromConfig(name, cfg, { cwd }));
        break;
      case "claude": {
        const createClaude = await loadClaudeFactory();
        providers.push(await createClaude(name, cfg, { cwd }));
        break;
      }
      case "cursor": {
        const createCursor = await loadCursorFactory();
        providers.push(await createCursor(name, cfg, { cwd }));
        break;
      }
      default:
        throw new Error(`Provider "${name}": unsupported kind "${(cfg as { kind?: string }).kind}".`);
    }
    built.add(name);
  }

  const defaultName = spec.config?.defaults?.provider;
  if (defaultName && !built.has(defaultName) && isKnownLangChainVendor(defaultName)) {
    const model = spec.config?.defaults?.model;
    providers.push(
      await createLangChainProviderFromConfig(
        defaultName,
        {
          kind: "langchain",
          vendor: defaultName,
          ...(model ? { model } : {}),
        },
        { cwd },
      ),
    );
    built.add(defaultName);
  }

  return providers;
}
