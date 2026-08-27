import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    "@flowgraph/core",
    "@flowgraph/spec",
    "deepagents",
    "@langchain/core",
  ],
});
