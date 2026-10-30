import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { collectGitDiff } from "./git-diff.js";

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-gitdiff-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "f.txt"), "a\n");
  git("add", "f.txt");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  fs.writeFileSync(path.join(dir, "f.txt"), "b\n");
  return dir;
}

describe("collectGitDiff", () => {
  it("returns stat and patch for the working tree", async () => {
    const dir = tmpRepo();
    const res = await collectGitDiff({ cwd: dir });
    expect(res.patch).toContain("+b");
    expect(res.stat).toContain("f.txt");
  });

  it("rejects an option-looking base (no --output file write)", async () => {
    const dir = tmpRepo();
    const target = path.join(dir, "PWNED");
    await expect(collectGitDiff({ cwd: dir, base: `--output=${target}` })).rejects.toThrow(/must not start with "-"/);
    expect(fs.existsSync(target)).toBe(false);
  });
});
