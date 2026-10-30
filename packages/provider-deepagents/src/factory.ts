import type { GraphSpec, DeepAgentsProviderConfig, ProviderConfig } from "@flowgraph/spec";
import {
  createLangChainChatModelFromConfig,
  type ProviderAdapter,
} from "@flowgraph/core";
import { createDeepAgentsProvider } from "./provider.js";

export interface DeepAgentsProviderFromConfigOptions {
  cwd?: string;
  spec?: GraphSpec;
}

export async function createDeepAgentsProviderFromConfig(
  name: string,
  cfg: DeepAgentsProviderConfig | (ProviderConfig & { kind: "deepagents" }),
  options: DeepAgentsProviderFromConfigOptions = {},
): Promise<ProviderAdapter> {
  const spec = options.spec;
  const modelProviderName =
    (cfg as DeepAgentsProviderConfig).modelProvider ??
    spec?.config?.defaults?.provider ??
    "main";
  const source = spec?.providers?.[modelProviderName];
  if (!source || source.kind !== "langchain") {
    throw new Error(
      `Deep Agents provider "${name}" inherits a LangChain ChatModel. ` +
        `Set providers.${modelProviderName}.kind: langchain (or config.defaults.provider).`,
    );
  }
  const model = await createLangChainChatModelFromConfig(
    modelProviderName,
    source,
    options.cwd ? { cwd: options.cwd } : {},
  );
  const agentOptions = (cfg as DeepAgentsProviderConfig).options;
  return createDeepAgentsProvider({
    name,
    model,
    ...(agentOptions ? { agentOptions } : {}),
  });
}
