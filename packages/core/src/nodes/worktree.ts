/**
 * Built-in node type: `worktree`
 *
 * Idempotent git worktree add / remove / status. `add` is guarded with
 * `ctx.once` so map/subgraph replay does not create a second tree.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { WorktreeWithSchema } from "@flowgraph/spec";
import { renderDeep } from "@flowgraph/expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { applyOutput } from "./output.js";
import { WORKTREES_CHANNEL } from "../runtime/state-annotation.js";

const execFileAsync = promisify(execFile);
const configSchema = WorktreeWithSchema;
type Config = z.infer<typeof configSchema>;

export interface WorktreeResult {
  path: string;
  branch: string;
  head: string;
  action: Config["action"];
}

export const worktreeNode = defineNode<Config>({
  type: "worktree",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: { sideEffecting: true },

  build(buildCtx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    const nodeId = String(nodeSpec["id"] ?? "worktree");
    return {
      contract: {},
      capabilities: { sideEffecting: true },

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const scope = {
          state,
          input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
          config: ctx.config,
          run: ctx.meta,
        };
        const action = config.action ?? "add";
        const repo = config.repo
          ? resolvePath(String(renderDeep(config.repo, scope)), ctx.workspace)
          : ctx.workspace;
        const root = buildCtx.worktreeRoot
          ? resolvePath(buildCtx.worktreeRoot, ctx.workspace)
          : ctx.workspace;

        if (action === "status") {
          const list = await git(repo, ["worktree", "list", "--porcelain"]);
          const result = { action, list, repo };
          ctx.emit("node.output", { worktree: result });
          return {
            update: applyOutput(config.output, result, { nodeId: String(nodeSpec["id"] ?? ctx.nodeId), scope }),
          };
        }

        if (action === "remove") {
          const wtPath = await requirePath(config.path, scope, ctx.workspace, root, nodeId);
          // --force (discard uncommitted changes) only for a worktree this
          // thread created; anything else must be clean or git refuses.
          const own = ownWorktrees(state).some((w) => w.path === wtPath && w.repo === repo);
          await git(repo, ["worktree", "remove", ...(own ? ["--force"] : []), "--", wtPath]);
          const result = { action, path: wtPath, repo, forced: own };
          ctx.emit("node.output", { worktree: result });
          return {
            update: applyOutput(config.output, result, { nodeId: String(nodeSpec["id"] ?? ctx.nodeId), scope }),
          };
        }

        const branch = String(renderDeep(config.branch ?? "", scope)).trim();
        if (!branch) {
          throw new Error(`worktree node "${nodeId}": action "add" requires with.branch.`);
        }
        await validateBranchName(repo, branch, nodeId);
        const wtPath = await requirePath(config.path, scope, ctx.workspace, root, nodeId);

        const added = await ctx.once(`worktree:add:${wtPath}`, async (): Promise<WorktreeResult> => {
          const exists = await branchExists(repo, branch);
          if (exists && !config.reset) {
            throw new Error(
              `worktree node "${nodeId}": branch "${branch}" already exists. ` +
                `Pick a new branch name, or set with.reset: true to reset it to HEAD (git worktree add -B).`,
            );
          }
          await git(repo, ["worktree", "add", exists ? "-B" : "-b", branch, "--", wtPath]);
          const head = (await git(wtPath, ["rev-parse", "HEAD"])).trim();
          return { path: wtPath, branch, head, action: "add" };
        });

        ctx.emit("node.output", { worktree: added });
        return {
          update: {
            ...applyOutput(config.output, added, { nodeId: String(nodeSpec["id"] ?? ctx.nodeId), scope }),
            [WORKTREES_CHANNEL]: [{ path: added.path, branch: added.branch, repo }],
          },
        };
      },
    };
  },
});

function ownWorktrees(state: Record<string, unknown>): Array<{ path: string; repo: string }> {
  const raw = state[WORKTREES_CHANNEL];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is { path: string; repo: string } =>
      Boolean(e) && typeof (e as { path?: unknown }).path === "string" && typeof (e as { repo?: unknown }).repo === "string",
    )
    .map((e) => ({ path: e.path, repo: e.repo }));
}

/** Reject option-looking or invalid branch names (`git check-ref-format --branch`). */
export async function validateBranchName(repo: string, branch: string, nodeId: string): Promise<void> {
  if (branch.startsWith("-") || /\s/.test(branch) || branch.includes("@{")) {
    throw new Error(`worktree node "${nodeId}": invalid branch name "${branch}".`);
  }
  let normalized: string;
  try {
    normalized = (await git(repo, ["check-ref-format", "--branch", branch])).trim();
  } catch {
    throw new Error(`worktree node "${nodeId}": invalid branch name "${branch}" (git check-ref-format).`);
  }
  if (normalized !== branch) {
    throw new Error(`worktree node "${nodeId}": invalid branch name "${branch}" (normalizes to "${normalized}").`);
  }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}

async function requirePath(
  raw: string | undefined,
  scope: Record<string, unknown>,
  workspace: string,
  root: string,
  nodeId: string,
): Promise<string> {
  const rendered = raw ? String(renderDeep(raw, scope)).trim() : "";
  if (!rendered) {
    throw new Error(`worktree node "${nodeId}": with.path is required.`);
  }
  if (rendered.startsWith("-")) {
    throw new Error(`worktree node "${nodeId}": invalid path "${rendered}".`);
  }
  const resolved = resolvePath(rendered, workspace);
  await assertInsideRoot(resolved, root, nodeId);
  return resolved;
}

/** `p` must be strictly inside `root`, also after resolving symlinks of its existing ancestors. */
export async function assertInsideRoot(p: string, root: string, nodeId: string): Promise<void> {
  const realRoot = await realpathOrSelf(root);
  const realP = await realpathExistingPrefix(p);
  for (const [candidate, base] of [
    [p, path.resolve(root)],
    [realP, realRoot],
  ] as const) {
    const rel = path.relative(base, candidate);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `worktree node "${nodeId}": path "${p}" must be inside the worktree root "${root}" ` +
          `(runtime.worktrees.root, default runtime.workspace).`,
      );
    }
  }
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

async function realpathExistingPrefix(p: string): Promise<string> {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  while (true) {
    try {
      const real = await fs.realpath(cur);
      return path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function resolvePath(p: string, workspace: string): string {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(workspace, p);
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr?.trim() || msg}`);
  }
}

/** Best-effort cleanup of worktrees recorded on `__worktrees`. */
export async function cleanupWorktrees(
  entries: Array<{ path?: unknown; repo?: unknown }>,
): Promise<void> {
  for (const entry of entries) {
    const wtPath = typeof entry.path === "string" ? entry.path : "";
    const repo = typeof entry.repo === "string" ? entry.repo : "";
    if (!wtPath || !repo) continue;
    try {
      // Entries come from __worktrees, i.e. trees this thread's worktree nodes created.
      await git(repo, ["worktree", "remove", "--force", "--", wtPath]);
    } catch {
      /* keep-on-failure — do not fail the run */
    }
  }
}
