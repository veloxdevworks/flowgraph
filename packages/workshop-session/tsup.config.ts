import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts", browser: "src/browser/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
