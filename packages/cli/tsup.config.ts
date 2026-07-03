import { defineConfig } from "tsup";
export default defineConfig([
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
    external: [
      "@veloxdevworks/flowgraph-provider-claude",
      "@veloxdevworks/flowgraph-provider-cursor",
      "@veloxdevworks/flowgraph-tui",
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
      "@veloxdevworks/flowgraph-provider-claude",
      "@veloxdevworks/flowgraph-provider-cursor",
      "@veloxdevworks/flowgraph-tui",
      "@anthropic-ai/claude-agent-sdk",
      "@cursor/sdk",
    ],
  },
]);
