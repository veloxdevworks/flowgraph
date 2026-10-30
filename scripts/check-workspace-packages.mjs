#!/usr/bin/env node
// Fails when a publishable workspace package points main/exports at build
// output it has no way to produce (no build script and no sources), e.g. a
// package.json-only placeholder. Run: pnpm check:packages
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const groups = ["packages", "examples", "automation"];
const problems = [];

function entryPoints(pkg) {
  const out = [];
  if (typeof pkg.main === "string") out.push(pkg.main);
  if (typeof pkg.types === "string") out.push(pkg.types);
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(pkg.exports);
  return out;
}

for (const group of groups) {
  const base = join(root, group);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base)) {
    const file = join(base, name, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (pkg.private) continue;
    const built = [...new Set(entryPoints(pkg))].filter((p) => /(^|\/)dist\//.test(p));
    if (built.length === 0) continue;
    const hasBuild = typeof pkg.scripts?.build === "string";
    const hasSrc = existsSync(join(base, name, "src"));
    if (!hasBuild || !hasSrc) {
      problems.push(
        `${group}/${name} (${pkg.name}): entry points ${built.join(", ")} but ` +
          `${!hasBuild ? "no build script" : ""}${!hasBuild && !hasSrc ? " and " : ""}${!hasSrc ? "no src/" : ""}`,
      );
    }
  }
}

if (problems.length) {
  console.error("Unbuildable publishable workspace packages:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("workspace packages OK");
