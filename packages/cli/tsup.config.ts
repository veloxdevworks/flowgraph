import { defineConfig } from "tsup";
export default defineConfig([
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
    external: [
      "@flowgraph/provider-claude",
      "@flowgraph/provider-cursor",
      "@flowgraph/provider-deepagents",
      "@flowgraph/tui",
      "@anthropic-ai/claude-agent-sdk",
      "@cursor/sdk",
    ],
  },
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    external: [
      "@flowgraph/provider-claude",
      "@flowgraph/provider-cursor",
      "@flowgraph/provider-deepagents",
      "@flowgraph/tui",
      "@anthropic-ai/claude-agent-sdk",
      "@cursor/sdk",
    ],
  },
]);
