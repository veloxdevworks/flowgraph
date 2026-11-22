import { hostExecAllowed, registry, WORKTREES_CHANNEL } from "@flowgraph/core";
import { cleanupWorktrees, worktreeNode } from "./node.js";

/** Register the `worktree` node type and end-of-run cleanup hook (idempotent). Runs on import. */
export function registerWorktreeNode(): void {
  if (!registry.has(worktreeNode.type)) registry.register(worktreeNode);
  registry.registerRunLifecycle("worktree-cleanup", {
    async onRunEnd({ spec, state, policy }) {
      if (spec.runtime?.worktrees?.cleanupOnEnd && hostExecAllowed(policy, "worktree")) {
        const entries = (state?.[WORKTREES_CHANNEL] as Array<{ path?: unknown; repo?: unknown }>) ?? [];
        await cleanupWorktrees(entries);
      }
    },
  });
}

registerWorktreeNode();

export {
  worktreeNode,
  WorktreeWithSchema,
  cleanupWorktrees,
  validateBranchName,
  assertInsideRoot,
  type WorktreeWith,
  type WorktreeResult,
} from "./node.js";
