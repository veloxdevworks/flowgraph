import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["@veloxdevworks/flowgraph-core", "@veloxdevworks/flowgraph-spec", "@cursor/sdk"],
});
