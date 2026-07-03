#!/usr/bin/env node
/**
 * Copy Graph JSON Schema into public/ for static hosting at /flowgraph/schema/v1.json
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(docsRoot, "../..");
const outDir = path.join(docsRoot, "public/schema");
const outFile = path.join(outDir, "v1.json");

mkdirSync(outDir, { recursive: true });

const cliBin = path.join(repoRoot, "packages/cli/dist/bin.js");
execFileSync(process.execPath, [cliBin, "schema", "--out", outFile], {
  cwd: repoRoot,
  stdio: "inherit",
});

console.log(`Synced schema → ${path.relative(repoRoot, outFile)}`);
