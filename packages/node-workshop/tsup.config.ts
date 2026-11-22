import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", contract: "src/contract.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["@flowgraph/core"],
});
