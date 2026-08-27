/**
 * Built-in node type: `worktree`
 *
 * Idempotent git worktree add / remove / status. `add` is guarded with
 * `ctx.once` so map/subgraph replay does not create a second tree.
 */

import { execFile } from "node:child_process";
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

  build(_ctx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
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

        if (action === "status") {
          const list = await git(repo, ["worktree", "list", "--porcelain"]);
          const result = { action, list, repo };
          ctx.emit("node.output", { worktree: result });
          return {
            update: applyOutput(config.output, result, {
              nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
              scope,
            }),
          };
        }

        if (action === "remove") {
          const wtPath = requirePath(config.path, scope, ctx.workspace, nodeSpec);
          await git(repo, ["worktree", "remove", "--force", wtPath]);
          const result = { action, path: wtPath, repo };
          ctx.emit("node.output", { worktree: result });
          return {
            update: applyOutput(config.output, result, {
              nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
              scope,
            }),
          };
        }

        const branch = String(renderDeep(config.branch ?? "", scope)).trim();
        if (!branch) {
          throw new Error(`worktree node "${String(nodeSpec["id"])}": action "add" requires with.branch.`);
        }
        const wtPath = requirePath(config.path, scope, ctx.workspace, nodeSpec);

        const added = await ctx.once(`worktree:add:${wtPath}`, async (): Promise<WorktreeResult> => {
          await git(repo, ["worktree", "add", "-B", branch, wtPath]);
          const head = (await git(wtPath, ["rev-parse", "HEAD"])).trim();
          return { path: wtPath, branch, head, action: "add" };
        });

        ctx.emit("node.output", { worktree: added });
        return {
          update: {
            ...applyOutput(config.output, added, {
              nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
              scope,
            }),
            [WORKTREES_CHANNEL]: [{ path: added.path, branch: added.branch, repo }],
          },
        };
      },
    };
  },
});

function requirePath(
  raw: string | undefined,
  scope: Record<string, unknown>,
  workspace: string,
  nodeSpec: Record<string, unknown>,
): string {
  const rendered = raw ? String(renderDeep(raw, scope)).trim() : "";
  if (!rendered) {
    throw new Error(`worktree node "${String(nodeSpec["id"])}": with.path is required.`);
  }
  return resolvePath(rendered, workspace);
}

function resolvePath(p: string, workspace: string): string {
  return path.isAbsolute(p) ? p : path.resolve(workspace, p);
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
      await git(repo, ["worktree", "remove", "--force", wtPath]);
    } catch {
      /* keep-on-failure — do not fail the run */
    }
  }
}
