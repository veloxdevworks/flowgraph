/**
 * Build provider adapters from a graph spec's `providers` block.
 *
 * When an SDK-based provider (claude/cursor/langchain) has no API key but a
 * matching local CLI binary is on PATH, we auto-prefer `createCliProvider`.
 */

import type { ProviderAdapter } from "@flowgraph/core";
import {
  createLangChainProviderFromConfig,
  isKnownLangChainVendor,
  createCliProvider,
  detectLocalCli,
  cliVendorForProviderKind,
  apiKeyEnvForProviderKind,
  hasApiKey,
  type CliVendor,
} from "@flowgraph/core";
import type { GraphSpec } from "@flowgraph/spec";

async function loadClaudeFactory() {
  try {
    const mod = await import("@flowgraph/provider-claude");
    return mod.createClaudeProviderFromConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find") || msg.includes("ERR_MODULE_NOT_FOUND")) {
      throw new Error(
        'Claude provider is not installed. Install it: pnpm add @flowgraph/provider-claude @anthropic-ai/claude-agent-sdk',
        { cause: err },
      );
    }
    throw err;
  }
}

async function loadCursorFactory() {
  try {
    const mod = await import("@flowgraph/provider-cursor");
    return mod.createCursorProviderFromConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find") || msg.includes("ERR_MODULE_NOT_FOUND")) {
      throw new Error(
        'Cursor provider is not installed. Install it: pnpm add @flowgraph/provider-cursor @cursor/sdk',
        { cause: err },
      );
    }
    throw err;
  }
}

async function loadDeepAgentsFactory() {
  const specifier = "@flowgraph/provider-deepagents";
  try {
    const mod = (await (Function("s", "return import(s)")(specifier) as Promise<{
      createDeepAgentsProviderFromConfig: (
        name: string,
        cfg: unknown,
        opts: { cwd?: string; spec?: GraphSpec },
      ) => Promise<ProviderAdapter>;
    }>));
    return mod.createDeepAgentsProviderFromConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find") || msg.includes("ERR_MODULE_NOT_FOUND") || msg.includes("Failed to resolve")) {
      throw new Error(
        'Deep Agents provider is not installed. Install it: pnpm add @flowgraph/provider-deepagents deepagents',
        { cause: err },
      );
    }
    throw err;
  }
}

async function tryCliFallback(
  name: string,
  kind: string,
  cfg: {
    vendor?: string | undefined;
    model?: string | undefined;
    cwd?: string | undefined;
    binary?: string | undefined;
  },
  cwd: string,
): Promise<ProviderAdapter | undefined> {
  const cliVendor = cliVendorForProviderKind(kind, cfg.vendor);
  if (!cliVendor) return undefined;

  const keyEnv = apiKeyEnvForProviderKind(kind, cfg.vendor);
  if (hasApiKey(keyEnv)) return undefined;

  const detected = await detectLocalCli(cliVendor, {
    ...(cfg.binary ? { binary: cfg.binary } : {}),
  });
  if (!detected.ok) return undefined;

  return createCliProvider({
    name,
    vendor: cliVendor,
    ...(cfg.model ? { model: cfg.model } : {}),
    cwd: cfg.cwd ?? cwd,
    ...(cfg.binary ? { binary: cfg.binary } : {}),
  });
}

export async function buildProviders(spec: GraphSpec, cwd = process.cwd()): Promise<ProviderAdapter[]> {
  const providers: ProviderAdapter[] = [];
  const built = new Set<string>();

  for (const [name, cfg] of Object.entries(spec.providers ?? {})) {
    switch (cfg.kind) {
      case "cli": {
        const vendor = cfg.vendor as CliVendor;
        const detected = await detectLocalCli(vendor, {
          ...(cfg.binary ? { binary: cfg.binary } : {}),
        });
        if (!detected.ok) {
          throw new Error(
            `Provider "${name}": local CLI binary "${detected.binary}" not found on PATH.`,
          );
        }
        providers.push(
          createCliProvider({
            name,
            vendor,
            ...(cfg.model ? { model: cfg.model } : {}),
            cwd: cfg.cwd ?? cwd,
            ...(cfg.binary ? { binary: cfg.binary } : {}),
          }),
        );
        break;
      }
      case "langchain": {
        const fallback = await tryCliFallback(name, "langchain", cfg, cwd);
        if (fallback) {
          providers.push(fallback);
        } else {
          providers.push(await createLangChainProviderFromConfig(name, cfg, { cwd }));
        }
        break;
      }
      case "claude": {
        const fallback = await tryCliFallback(name, "claude", cfg, cwd);
        if (fallback) {
          providers.push(fallback);
        } else {
          const createClaude = await loadClaudeFactory();
          providers.push(await createClaude(name, cfg, { cwd }));
        }
        break;
      }
      case "cursor": {
        const fallback = await tryCliFallback(name, "cursor", cfg, cwd);
        if (fallback) {
          providers.push(fallback);
        } else {
          const createCursor = await loadCursorFactory();
          providers.push(await createCursor(name, cfg, { cwd }));
        }
        break;
      }
      case "deepagents": {
        const createDeep = await loadDeepAgentsFactory();
        providers.push(await createDeep(name, cfg, { cwd, spec }));
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
    const fallback = await tryCliFallback(
      defaultName,
      "langchain",
      { vendor: defaultName, ...(model ? { model } : {}) },
      cwd,
    );
    if (fallback) {
      providers.push(fallback);
    } else {
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
    }
    built.add(defaultName);
  }

  const needsDeepHub =
    spec.nodes.some((n) => (n.with as { hub?: string } | undefined)?.hub === "deepagents") ||
    Object.values(spec.providers ?? {}).some((p) => p.kind === "deepagents");
  if (needsDeepHub && !built.has("deepagents") && !providers.some((p) => p.name === "deepagents")) {
    const createDeep = await loadDeepAgentsFactory();
    providers.push(
      await createDeep("deepagents", { kind: "deepagents" }, { cwd, spec }),
    );
    built.add("deepagents");
  }

  return providers;
}
