import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const docsRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(docsRoot, "../..");

export default defineConfig({
  base: "/flowgraph/",
  root: ".",
  plugins: [tailwindcss(), react()],
  server: {
    port: 5175,
    fs: { allow: [docsRoot, repoRoot] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
