import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeGitRemote, resolveMemoryIdentity } from "./memory-identity.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fg-ident-"));
  dirs.push(d);
  return d;
}

describe("normalizeGitRemote", () => {
  it.each([
    ["git@github.com:acme/web-app.git", "github.com/acme/web-app"],
    ["https://github.com/acme/web-app.git", "github.com/acme/web-app"],
    ["https://user:tok@GitHub.com/acme/web-app/", "github.com/acme/web-app"],
    ["ssh://git@github.com:22/acme/web-app.git", "github.com/acme/web-app"],
    ["git@gitlab.example.com:group/sub/repo", "gitlab.example.com/group/sub/repo"],
  ])("%s → %s", (url, want) => {
    expect(normalizeGitRemote(url)).toBe(want);
  });

  it("rejects local paths", () => {
    expect(normalizeGitRemote("/srv/git/repo.git")).toBeUndefined();
    expect(normalizeGitRemote("file:///srv/git/repo.git")).toBeUndefined();
    expect(normalizeGitRemote("")).toBeUndefined();
  });
});

describe("resolveMemoryIdentity", () => {
  const noGit = () => undefined;

  it("env wins, then project config, then global config", () => {
    const cwd = tmp();
    const home = tmp();
    fs.mkdirSync(path.join(cwd, ".flowgraph"));
    fs.writeFileSync(path.join(cwd, ".flowgraph", "config.yaml"), "memory:\n  project: acme/web\n");
    fs.mkdirSync(path.join(home, ".config", "flowgraph"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "flowgraph", "config.yaml"), "memory:\n  org: acme\n  project: ignored\n");
    const id = resolveMemoryIdentity({ cwd, homedir: home, env: { FLOWGRAPH_USER: "pat" }, git: noGit });
    expect(id).toMatchObject({ org: "acme", project: "acme/web", user: "pat" });
    expect(id.sources.user).toBe("FLOWGRAPH_USER");
  });

  it("defaults the project to the normalized git origin and the user to git email", () => {
    const git = (args: string[]) =>
      args.includes("remote.origin.url") ? "git@github.com:acme/web-app.git" : args.includes("user.email") ? "dev@acme.test" : undefined;
    const id = resolveMemoryIdentity({ cwd: tmp(), homedir: tmp(), env: {}, git });
    expect(id).toMatchObject({ org: "local", project: "github.com/acme/web-app", user: "dev@acme.test" });
    expect(id.notice).toBeUndefined();
  });

  it("falls back to a path hash with a notice, and the OS username", () => {
    const id = resolveMemoryIdentity({ cwd: tmp(), homedir: tmp(), env: {}, git: noGit, username: () => "osuser" });
    expect(id.project).toMatch(/^path:[0-9a-f]{8}$/);
    expect(id.notice).toMatch(/no git origin/);
    expect(id.user).toBe("osuser");
  });
});
