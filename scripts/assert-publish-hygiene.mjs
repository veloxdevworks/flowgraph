#!/usr/bin/env node
/**
 * Assert packed public packages are consumer-safe:
 *   - package.json has no workspace:* (pnpm pack rewrites it; npm pack does not)
 *   - tarball is dist + README + LICENSE (+ package.json), not src/tests/.turbo
 *
 * Release MUST use pnpm (see CONTRIBUTING.md). `npx changeset publish` / npm
 * publish leaves workspace:* in the manifest and will fail this check.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGES = [
  { dir: "packages/core", name: "@veloxdevworks/flowgraph-core" },
  { dir: "packages/cli", name: "@veloxdevworks/flowgraph-cli" },
  { dir: "packages/provider-claude", name: "@veloxdevworks/flowgraph-provider-claude" },
];

const FORBIDDEN_PATH_RE = /(^|\/)(src\/|.*\.test\.|tests\/|\.turbo\/)/;

function listTar(tgz) {
  const out = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^package\//, ""));
}

function readPackedManifest(tgz) {
  const json = execFileSync("tar", ["-xOf", tgz, "package/package.json"], { encoding: "utf8" });
  return JSON.parse(json);
}

function collectWorkspaceStar(obj, prefix, hits) {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.includes("workspace:*")) {
      hits.push(`${prefix}.${k}=${v}`);
    }
  }
}

let failed = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flowgraph-pack-"));

try {
  for (const pkg of PACKAGES) {
    const cwd = path.join(repoRoot, pkg.dir);
    execFileSync("pnpm", ["pack", "--pack-destination", tmp], {
      cwd,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (!tgz) {
      console.error(`${pkg.name}: pnpm pack produced no tarball`);
      failed++;
      continue;
    }
    const tgzPath = path.join(tmp, tgz);
    const manifest = readPackedManifest(tgzPath);
    const hits = [];
    collectWorkspaceStar(manifest.dependencies, "dependencies", hits);
    collectWorkspaceStar(manifest.peerDependencies, "peerDependencies", hits);
    collectWorkspaceStar(manifest.optionalDependencies, "optionalDependencies", hits);
    if (hits.length) {
      console.error(`${pkg.name}: packed manifest still contains workspace:*`);
      for (const h of hits) console.error(`  ${h}`);
      failed++;
    }

    const files = listTar(tgzPath);
    const forbidden = files.filter((f) => FORBIDDEN_PATH_RE.test(f));
    if (forbidden.length) {
      console.error(`${pkg.name}: tarball includes source/tests/turbo:`);
      for (const f of forbidden.slice(0, 20)) console.error(`  ${f}`);
      failed++;
    }
    for (const required of ["package.json", "README.md", "LICENSE"]) {
      if (!files.includes(required)) {
        console.error(`${pkg.name}: tarball missing ${required}`);
        failed++;
      }
    }
    if (!files.some((f) => f === "dist" || f.startsWith("dist/"))) {
      console.error(`${pkg.name}: tarball missing dist/`);
      failed++;
    }

    console.log(`${pkg.name}: ${files.length} files, no workspace:*`);
    fs.unlinkSync(tgzPath);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  process.exit(1);
}
console.log("publish hygiene ok");
