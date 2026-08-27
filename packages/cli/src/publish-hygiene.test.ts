import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("publish hygiene", () => {
  it("packed core/cli/provider manifests have no workspace:* and no src/tests", () => {
    const script = path.join(repoRoot, "scripts/assert-publish-hygiene.mjs");
    const out = execFileSync(process.execPath, [script], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(out).toContain("publish hygiene ok");
    expect(out).toMatch(/flowgraph-core: \d+ files, no workspace:\*/);
    expect(out).toMatch(/flowgraph-cli: \d+ files, no workspace:\*/);
  });
});
