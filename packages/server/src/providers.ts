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
// Registers the media vendors and moved product node packages so trusted runs
// can use media, workshop, demo, service, port, worktree, and localTools;
// untrusted uploads remain restricted by the default-deny upload policy.
import "@flowgraph/media";
import "@flowgraph/node-demo";
import "@flowgraph/node-port";
import "@flowgraph/node-service";
import "@flowgraph/node-workshop";
import "@flowgraph/node-worktree";
import "@flowgraph/tools-fs";
import { ServerRequestError } from "./errors.js";

/** Refuse providers an untrusted author may not configure (checked again when the graph runs). */
function assertUntrustedProvider(name: string, cfg: { vendor?: unknown; baseUrl?: unknown }): void {
  if (cfg.vendor === "ollama") {
    throw new ServerRequestError(403, "PROVIDER_ENDPOINT_BLOCKED", `Provider "${name}": vendor ollama talks to a model server on the host, which untrusted authors may not use`);
  }
  if (cfg.baseUrl !== undefined) {
    throw new ServerRequestError(403, "PROVIDER_ENDPOINT_BLOCKED", `Provider "${name}": baseUrl is set by the server operator for untrusted authors`);
  }
}

export async function buildServerProviders(
  spec: GraphSpec,
  cwd = process.cwd(),
  opts: { dryRun?: boolean; untrusted?: boolean } = {},
): Promise<ProviderAdapter[]> {
  if (opts.dryRun) {
    return [mockProvider];
  }
  const providers: ProviderAdapter[] = [];
  const built = new Set<string>();

  for (const [name, cfg] of Object.entries(spec.providers ?? {})) {
    if ((cfg as { kind?: string }).kind === "media") {
      // Built by compileGraph (media providers are not agent providers), but
      // an untrusted author's endpoint settings are still refused here.
      if (opts.untrusted) assertUntrustedProvider(name, cfg as Record<string, unknown>);
      continue;
    }
    switch (cfg.kind) {
      case "langchain": {
        if (opts.untrusted) assertUntrustedProvider(name, cfg);
        providers.push(await createLangChainProviderFromConfig(name, cfg, { cwd, secrets: spec.secrets }));
        built.add(name);
        break;
      }
      case "plugin": {
        if (opts.untrusted) {
          throw new ServerRequestError(
            403,
            "PROVIDER_PLUGIN_BLOCKED",
            `Provider "${name}": kind: plugin is not allowed for untrusted graph uploads.`,
          );
        }
        // Resolved and options-validated per compile by compileGraph against server-registered plugins.
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
    if (opts.untrusted) assertUntrustedProvider(defaultName, { vendor: defaultName });
    const model = spec.config?.defaults?.model;
    providers.push(
      await createLangChainProviderFromConfig(
        defaultName,
        {
          kind: "langchain",
          vendor: defaultName,
          ...(model ? { model } : {}),
        },
        { cwd, secrets: spec.secrets },
      ),
    );
  }

  return providers;
}
