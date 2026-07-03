/**
 * Build a LangChain ChatModel from declarative provider config (YAML `providers` block).
 */

import type { LangChainVendor, ProviderConfig } from "@veloxdevworks/flowgraph-spec";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ProviderAdapter } from "../types.js";
import { createLangChainProvider, type ChatModelLike, type LangChainProviderOptions } from "./provider.js";

const DEFAULT_API_KEY_ENV: Record<LangChainVendor, string | undefined> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  xai: "XAI_API_KEY",
  ollama: undefined,
  google: "GOOGLE_API_KEY",
};

const VENDOR_PACKAGES: Record<LangChainVendor, string> = {
  openai: "@langchain/openai",
  anthropic: "@langchain/anthropic",
  xai: "@langchain/xai",
  ollama: "@langchain/ollama",
  google: "@langchain/google-genai",
};

export interface LangChainProviderConfigInput {
  kind?: "langchain";
  vendor: LangChainVendor | string;
  model?: string | undefined;
  options?: Record<string, unknown> | undefined;
  baseUrl?: string | undefined;
  apiKeyEnv?: string | undefined;
}

function isLangChainVendor(v: string): v is LangChainVendor {
  return v === "openai" || v === "anthropic" || v === "xai" || v === "ollama" || v === "google";
}

function readEnvKey(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return raw.trim();
}

function resolveApiKey(vendor: LangChainVendor, apiKeyEnv: string): string | undefined {
  const primary = readEnvKey(apiKeyEnv);
  if (primary) return primary;
  if (vendor === "xai" && apiKeyEnv === "XAI_API_KEY") {
    return readEnvKey("GROK_API_KEY");
  }
  return undefined;
}

function installHint(vendor: string): string {
  const pkg = isLangChainVendor(vendor) ? VENDOR_PACKAGES[vendor] : `@langchain/${vendor}`;
  return `Install the vendor package: pnpm add ${pkg}`;
}

async function importVendorModule(
  vendor: LangChainVendor,
  cwd: string,
): Promise<Record<string, new (opts: Record<string, unknown>) => unknown>> {
  const pkg = VENDOR_PACKAGES[vendor];
  try {
    const req = createRequire(path.join(cwd, "package.json"));
    const resolved = req.resolve(pkg);
    return (await import(pathToFileURL(resolved).href)) as Record<
      string,
      new (opts: Record<string, unknown>) => unknown
    >;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find module") || msg.includes("Cannot find package") || msg.includes("ERR_MODULE_NOT_FOUND")) {
      throw new Error(`LangChain vendor "${vendor}" is not installed. ${installHint(vendor)}`, { cause: err });
    }
    throw err;
  }
}

async function loadVendorModel(cfg: LangChainProviderConfigInput, cwd: string): Promise<ChatModelLike> {
  const vendor = cfg.vendor;
  if (!isLangChainVendor(vendor)) {
    throw new Error(`Unknown LangChain vendor "${vendor}". Supported: ${Object.keys(VENDOR_PACKAGES).join(", ")}.`);
  }

  const modelOpts: Record<string, unknown> = { ...(cfg.options ?? {}) };
  if (cfg.model) modelOpts["model"] = cfg.model;

  const apiKeyEnv = cfg.apiKeyEnv ?? DEFAULT_API_KEY_ENV[vendor];
  if (apiKeyEnv) {
    const key = resolveApiKey(vendor, apiKeyEnv);
    if (!key) {
      const hints =
        vendor === "xai"
          ? `Set ${apiKeyEnv} (or GROK_API_KEY). Get a key at https://console.x.ai`
          : `Set environment variable ${apiKeyEnv}.`;
      throw new Error(`Missing API key for vendor "${vendor}". ${hints}`);
    }
    modelOpts["apiKey"] = key;
  }

  if (cfg.baseUrl) {
    modelOpts["baseUrl"] = cfg.baseUrl;
  }

  try {
    const mod = await importVendorModule(vendor, cwd);
    switch (vendor) {
      case "openai": {
        const ChatOpenAI = mod["ChatOpenAI"];
        if (!ChatOpenAI) throw new Error(`@langchain/openai: missing ChatOpenAI export`);
        return new ChatOpenAI(modelOpts) as unknown as ChatModelLike;
      }
      case "anthropic": {
        const ChatAnthropic = mod["ChatAnthropic"];
        if (!ChatAnthropic) throw new Error(`@langchain/anthropic: missing ChatAnthropic export`);
        return new ChatAnthropic(modelOpts) as unknown as ChatModelLike;
      }
      case "xai": {
        const ChatXAI = mod["ChatXAI"];
        if (!ChatXAI) throw new Error(`@langchain/xai: missing ChatXAI export`);
        return new ChatXAI(modelOpts) as unknown as ChatModelLike;
      }
      case "ollama": {
        const ChatOllama = mod["ChatOllama"];
        if (!ChatOllama) throw new Error(`@langchain/ollama: missing ChatOllama export`);
        return new ChatOllama(modelOpts) as unknown as ChatModelLike;
      }
      case "google": {
        const ChatGoogleGenerativeAI = mod["ChatGoogleGenerativeAI"];
        if (!ChatGoogleGenerativeAI) throw new Error(`@langchain/google-genai: missing ChatGoogleGenerativeAI export`);
        return new ChatGoogleGenerativeAI(modelOpts) as unknown as ChatModelLike;
      }
      default: {
        const _exhaustive: never = vendor;
        throw new Error(`Unhandled vendor: ${_exhaustive}`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("not installed")) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find package") || msg.includes("ERR_MODULE_NOT_FOUND")) {
      throw new Error(
        `LangChain vendor "${vendor}" is not installed. ${installHint(vendor)}`,
        { cause: err },
      );
    }
    throw err;
  }
}

export interface LangChainProviderFromConfigOptions extends LangChainProviderOptions {
  /** Working directory for resolving optional vendor packages (graph cwd). */
  cwd?: string;
}

/**
 * Create a registered provider adapter from a `providers` block entry.
 */
export async function createLangChainProviderFromConfig(
  name: string,
  cfg: LangChainProviderConfigInput | ProviderConfig,
  options: LangChainProviderFromConfigOptions = {},
): Promise<ProviderAdapter> {
  if (cfg.kind !== undefined && cfg.kind !== "langchain") {
    throw new Error(`Provider "${name}": only kind "langchain" is supported (got "${cfg.kind}").`);
  }

  const cwd = options.cwd ?? process.cwd();
  const model = await loadVendorModel(
    {
      vendor: cfg.vendor,
      model: cfg.model,
      options: cfg.options,
      baseUrl: cfg.baseUrl,
      apiKeyEnv: cfg.apiKeyEnv,
    },
    cwd,
  );

  const providerOpts: LangChainProviderOptions = { name, ...options };
  if (cfg.model) {
    providerOpts.models = [cfg.model];
  }

  return createLangChainProvider(model, providerOpts);
}

/** Known vendor ids for shorthand `config.defaults.provider: anthropic`. */
export const LANGCHAIN_VENDORS = Object.keys(VENDOR_PACKAGES) as LangChainVendor[];

export function isKnownLangChainVendor(name: string): name is LangChainVendor {
  return isLangChainVendor(name);
}
