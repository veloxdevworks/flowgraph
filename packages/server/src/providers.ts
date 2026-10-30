/**
 * Build provider adapters for hosted runs from the graph's `providers` block.
 * Server-side only — no CLI fallbacks (container may not have local CLIs).
 */

import type { ProviderAdapter } from "@flowgraph/core";
import {
  createLangChainProviderFromConfig,
  isKnownLangChainVendor,
  mockProvider,
} from "@flowgraph/core";
import type { GraphSpec } from "@flowgraph/spec";

export async function buildServerProviders(
  spec: GraphSpec,
  cwd = process.cwd(),
  opts: { dryRun?: boolean } = {},
): Promise<ProviderAdapter[]> {
  if (opts.dryRun) {
    return [mockProvider];
  }
  const providers: ProviderAdapter[] = [];
  const built = new Set<string>();

  for (const [name, cfg] of Object.entries(spec.providers ?? {})) {
    switch (cfg.kind) {
      case "langchain": {
        providers.push(await createLangChainProviderFromConfig(name, cfg, { cwd }));
        built.add(name);
        break;
      }
      case "cli":
      case "claude":
      case "cursor":
        throw new Error(
          `Provider "${name}" kind "${cfg.kind}" is not supported on the hosted server. ` +
            "Use kind: langchain (including vendor: bedrock) with server-side credentials.",
        );
      default:
        throw new Error(
          `Provider "${name}": unsupported kind "${(cfg as { kind?: string }).kind}".`,
        );
    }
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
  }

  return providers;
}
