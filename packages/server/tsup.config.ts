import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
    external: [
      "@flowgraph/core",
      "@flowgraph/spec",
      "@flowgraph/checkpoint-postgres",
      "@langchain/aws",
      "@langchain/anthropic",
      "@langchain/openai",
      "@langchain/google-genai",
      "@langchain/ollama",
      "@langchain/xai",
    ],
  },
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    external: [
      "@flowgraph/core",
      "@flowgraph/spec",
      "@flowgraph/checkpoint-postgres",
      "@langchain/aws",
      "@langchain/anthropic",
      "@langchain/openai",
      "@langchain/google-genai",
      "@langchain/ollama",
      "@langchain/xai",
    ],
  },
]);
