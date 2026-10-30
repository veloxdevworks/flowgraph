/**
 * Who a CLI run's memory belongs to: (org, project, user).
 *
 *   org:     FLOWGRAPH_ORG     → .flowgraph/config.yaml memory.org     → ~/.config/flowgraph/config.yaml → "local"
 *   project: FLOWGRAPH_PROJECT → .flowgraph/config.yaml memory.project → git origin (normalized) → path:<sha8 of realpath>
 *   user:    FLOWGRAPH_USER    → config memory.user                    → git config user.email   → OS username
 *
 * The project defaults to the git origin URL so two clones of the same repo
 * share project memory, and two unrelated repos never do.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import yaml from "yaml";
import type { MemoryIdentity } from "@flowgraph/core";

export interface ResolvedMemoryIdentity extends MemoryIdentity {
  /** Where each part came from, for `flowgraph validate` / debug output. */
  sources: { org: string; project: string; user: string };
  /** Set when the project fell back to a path hash (no git origin). */
  notice?: string | undefined;
}

export interface MemoryIdentityEnv {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  git?: (args: string[], cwd: string) => string | undefined;
  username?: () => string | undefined;
}

/**
 * Normalize a git remote to `host/owner/repo`:
 *   git@github.com:Acme/Web.git, https://u:p@GitHub.com/Acme/Web/, ssh://git@github.com:22/Acme/Web.git
 *   → github.com/Acme/Web
 * Host is lowercased; credentials, ports, `.git` and trailing slashes are dropped.
 */
export function normalizeGitRemote(url: string): string | undefined {
  const raw = url.trim();
  if (!raw) return undefined;
  let host: string;
  let p: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return undefined;
    }
    if (u.protocol === "file:") return undefined;
    host = u.hostname;
    p = u.pathname;
  } else if (scp && !raw.startsWith("/")) {
    host = scp[1]!;
    p = scp[2]!;
  } else {
    return undefined;
  }
  p = p.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!host || !p) return undefined;
  return `${host.toLowerCase()}/${p}`;
}

function readMemoryConfig(file: string): Record<string, unknown> {
  try {
    const doc = yaml.parse(fs.readFileSync(file, "utf8")) as { memory?: unknown } | null;
    const m = doc?.memory;
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function defaultGit(args: string[], cwd: string): string | undefined {
  try {
    const out = execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).toString().trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function defaultUsername(): string | undefined {
  try {
    return os.userInfo().username || undefined;
  } catch {
    return process.env["USER"] ?? process.env["USERNAME"];
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function resolveMemoryIdentity(opts: MemoryIdentityEnv = {}): ResolvedMemoryIdentity {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const git = opts.git ?? defaultGit;
  const local = readMemoryConfig(path.join(cwd, ".flowgraph", "config.yaml"));
  const global = readMemoryConfig(path.join(opts.homedir ?? os.homedir(), ".config", "flowgraph", "config.yaml"));

  const pick = (envName: string, key: string): [string, string] | undefined => {
    const e = str(env[envName]);
    if (e) return [e, envName];
    const l = str(local[key]);
    if (l) return [l, `.flowgraph/config.yaml memory.${key}`];
    const g = str(global[key]);
    if (g) return [g, `~/.config/flowgraph/config.yaml memory.${key}`];
    return undefined;
  };

  const [org, orgSrc] = pick("FLOWGRAPH_ORG", "org") ?? ["local", "default"];

  let notice: string | undefined;
  let project: string;
  let projectSrc: string;
  const pj = pick("FLOWGRAPH_PROJECT", "project");
  if (pj) [project, projectSrc] = pj;
  else {
    const origin = git(["config", "--get", "remote.origin.url"], cwd);
    const norm = origin ? normalizeGitRemote(origin) : undefined;
    if (norm) {
      project = norm;
      projectSrc = "git remote.origin.url";
    } else {
      let real = cwd;
      try {
        real = fs.realpathSync(cwd);
      } catch {
        /* keep cwd */
      }
      project = `path:${createHash("sha256").update(real).digest("hex").slice(0, 8)}`;
      projectSrc = "working directory";
      notice =
        `memory project is ${project} (no git origin in ${real}); ` +
        "moving this directory starts fresh project memory. Set FLOWGRAPH_PROJECT or memory.project in .flowgraph/config.yaml to pin it.";
    }
  }

  let user: string | undefined;
  let userSrc: string;
  const us = pick("FLOWGRAPH_USER", "user");
  if (us) [user, userSrc] = us;
  else {
    const email = git(["config", "user.email"], cwd);
    if (email) {
      user = email;
      userSrc = "git config user.email";
    } else {
      user = (opts.username ?? defaultUsername)();
      userSrc = "OS username";
    }
  }

  return {
    org,
    project,
    ...(user ? { user } : {}),
    sources: { org: orgSrc, project: projectSrc, user: user ? userSrc : "none" },
    ...(notice ? { notice } : {}),
  };
}
