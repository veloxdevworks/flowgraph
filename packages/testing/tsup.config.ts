import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts", "src/memory-conformance.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["vitest"],
});
