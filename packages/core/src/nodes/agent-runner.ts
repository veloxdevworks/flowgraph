/**
 * Shared agent-definition loading: resolve an AGENT.md via aliases/path.
 * Used by the `agent` node when `with.agent` is set.
 */

import { resolveAgentPath } from "../agent-resolver.js";
import { loadAgentDef } from "../agents/loader.js";
import type { AgentDef } from "../agents/schema.js";
import type { NodeRunContext } from "../context.js";

export async function loadResolvedAgent(uses: string, ctx: NodeRunContext): Promise<AgentDef> {
  const agentDir = await resolveAgentPath(uses, {
    cwd: ctx.workspace,
    aliases:
      (ctx.config as Record<string, unknown> & { agents?: Record<string, string> })?.agents ?? {},
  });
  const { agent, diagnostics } = await loadAgentDef(agentDir);
  if (!agent) {
    throw new Error(`could not load agent "${uses}": ${diagnostics.map((d) => d.message).join("; ")}`);
  }
  return agent;
}
