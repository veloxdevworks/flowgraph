/**
 * Host-set limits on what a graph may run. A multi-user host (the server)
 * compiles graphs uploaded by untrusted authors with a policy that refuses
 * node types able to run host commands, and refuses subgraphs that load graph
 * files from the host's disk. The policy is checked when nodes are built
 * (compile, and again inside map and embedded subgraphs at run time) so a spec
 * that skipped the host's upload check still cannot run a blocked node.
 */

import type { NodeRunContext } from "./context.js";
import type { OutboundHttpPolicy } from "./outbound-http.js";

/** Key of the policy on the run context (copied into every node context). */
export const NODE_POLICY = Symbol.for("flowgraph.nodePolicy");

export interface NodePolicy {
  /** Node types that may not be built or run (map inners and agent skill tools included). */
  blockedTypes?: readonly string[] | undefined;
  /** Refuse subgraph `uses` references, which load graph files from the host's disk. Inline `spec` is allowed. */
  blockSubgraphFiles?: boolean | undefined;
  /** Make `{{ secret.X }}` in http / webhook templates fail instead of reading the host environment. */
  blockSecrets?: boolean | undefined;
  /**
   * Limits on where http and webhook nodes may connect (public addresses only,
   * checked after DNS and on every redirect). Unset: plain fetch.
   */
  outboundHttp?: OutboundHttpPolicy | undefined;
  /** Refuse `mcpServers` and run without an MCP hub, so no node or agent can reach an MCP server. */
  blockMcp?: boolean | undefined;
  /** Refuse `localTools` (host filesystem tools for agents). */
  blockLocalTools?: boolean | undefined;
  /** Refuse `requires` binary checks, which reveal what is installed on the host. */
  blockHostProbes?: boolean | undefined;
  /**
   * Agent function tools (`{ function: name }`, and builtins mapped onto a
   * registered tool) a graph may call, by registered name. Any other is
   * refused when the agent is built and again when the tool is called. Unset:
   * every registered tool. Tools that start host processes (start_service,
   * restart_service, stop_service) also obey `blockedTypes` for "service".
   */
  allowedTools?: readonly string[] | undefined;
  /** Registered functions a `function` node may call, by name. Unset: every registered function. */
  allowedFunctions?: readonly string[] | undefined;
  /** Refuse node features that run a host program outside `blockedTypes`: a workshop `diff` that runs git. */
  blockHostExec?: boolean | undefined;
  /** Who set the policy, for error messages (e.g. "uploaded graphs from untrusted authors"). */
  reason?: string | undefined;
}

export type NodePolicyErrorCode =
  | "NODE_TYPE_BLOCKED"
  | "SUBGRAPH_FILE_BLOCKED"
  | "SECRET_REFERENCE_BLOCKED"
  | "OUTBOUND_ADDRESS_BLOCKED"
  | "OUTBOUND_URL_BLOCKED"
  | "OUTBOUND_RESPONSE_TOO_LARGE"
  | "OUTBOUND_TIMEOUT"
  | "MCP_BLOCKED"
  | "LOCAL_TOOLS_BLOCKED"
  | "HOST_PROBE_BLOCKED"
  | "TOOL_BLOCKED"
  | "FUNCTION_BLOCKED"
  | "HOST_EXEC_BLOCKED"
  | "RESERVED_CHANNEL_BLOCKED";

export class NodePolicyError extends Error {
  constructor(
    readonly code: NodePolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NodePolicyError";
  }
}

function suffix(policy: NodePolicy): string {
  return policy.reason ? ` (${policy.reason})` : "";
}

/** Throws NODE_TYPE_BLOCKED when the policy blocks `type`. `where` names the node for the message. */
export function assertNodeTypeAllowed(policy: NodePolicy | undefined, type: string, where: string): void {
  if (!policy?.blockedTypes?.includes(type)) return;
  throw new NodePolicyError("NODE_TYPE_BLOCKED", `${where}: node type "${type}" is not allowed here${suffix(policy)}`);
}

/** Throws SUBGRAPH_FILE_BLOCKED when the policy refuses file-based subgraphs. */
export function assertSubgraphFileAllowed(policy: NodePolicy | undefined, uses: string, where: string): void {
  if (!policy?.blockSubgraphFiles) return;
  throw new NodePolicyError(
    "SUBGRAPH_FILE_BLOCKED",
    `${where}: subgraph uses "${uses}" loads a graph file from the host, which is not allowed here${suffix(policy)}; embed it with spec: instead`,
  );
}

/** Throws SECRET_REFERENCE_BLOCKED when the policy refuses host secret lookups. */
export function assertSecretAllowed(policy: NodePolicy | undefined, name: string, where: string): void {
  if (!policy?.blockSecrets) return;
  throw new NodePolicyError(
    "SECRET_REFERENCE_BLOCKED",
    `${where}: secret.${name} reads the host environment, which is not allowed here${suffix(policy)}`,
  );
}

/** Throws MCP_BLOCKED / LOCAL_TOOLS_BLOCKED when a graph declares what the policy refuses. */
export function assertGraphToolsAllowed(
  policy: NodePolicy | undefined,
  graph: { mcpServers?: Record<string, unknown> | undefined; localTools?: unknown },
  where: string,
): void {
  if (!policy) return;
  if (policy.blockMcp && graph.mcpServers && Object.keys(graph.mcpServers).length > 0) {
    throw new NodePolicyError("MCP_BLOCKED", `${where}: mcpServers start or reach MCP servers from the host, which is not allowed here${suffix(policy)}`);
  }
  if (policy.blockLocalTools && graph.localTools !== undefined && graph.localTools !== null) {
    throw new NodePolicyError("LOCAL_TOOLS_BLOCKED", `${where}: localTools give agents the host filesystem, which is not allowed here${suffix(policy)}`);
  }
}

/** Throws HOST_PROBE_BLOCKED when the policy refuses `requires` binary checks. */
export function assertHostProbeAllowed(policy: NodePolicy | undefined, requires: readonly unknown[] | undefined, where: string): void {
  if (!policy?.blockHostProbes || !requires?.length) return;
  throw new NodePolicyError(
    "HOST_PROBE_BLOCKED",
    `${where}: requires checks which binaries are installed on the host, which is not allowed here${suffix(policy)}`,
  );
}

/** Throws TOOL_BLOCKED when `allowedTools` does not list the registered tool `name`. */
export function assertToolAllowed(policy: NodePolicy | undefined, name: string, where: string): void {
  if (!policy?.allowedTools || policy.allowedTools.includes(name)) return;
  throw new NodePolicyError(
    "TOOL_BLOCKED",
    `${where}: tool function "${name}" is not allowed here${suffix(policy)}` +
      (policy.allowedTools.length ? `; allowed: ${policy.allowedTools.join(", ")}` : ""),
  );
}

/** Throws FUNCTION_BLOCKED when `allowedFunctions` does not list the registered function `name`. */
export function assertFunctionAllowed(policy: NodePolicy | undefined, name: string, where: string): void {
  if (!policy?.allowedFunctions || policy.allowedFunctions.includes(name)) return;
  throw new NodePolicyError("FUNCTION_BLOCKED", `${where}: registered function "${name}" is not allowed here${suffix(policy)}`);
}

/** Throws HOST_EXEC_BLOCKED when the policy refuses running a host program for `what`. */
export function assertHostExecAllowed(policy: NodePolicy | undefined, what: string, where: string): void {
  if (!policy?.blockHostExec) return;
  throw new NodePolicyError("HOST_EXEC_BLOCKED", `${where}: ${what} runs a program on the host, which is not allowed here${suffix(policy)}`);
}

/**
 * Registered tools an agent tool list refers to: `{ function }` names and
 * builtins mapped onto registered tools (see BUILTIN_TOOL_TARGETS).
 */
export function registeredToolNamesOf(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const out: string[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    if (typeof r.function === "string") out.push(r.function);
    if (Array.isArray(r.builtin)) {
      for (const b of r.builtin) {
        const target = typeof b === "string" ? BUILTIN_TOOL_TARGETS[b] : undefined;
        if (target) out.push(target);
      }
    }
  }
  return out;
}

/** Claude/Cursor-style builtin names that run a registered localTools handler when one exists. */
export const BUILTIN_TOOL_TARGETS: Readonly<Record<string, string>> = {
  Read: "fs_read",
  Write: "fs_write",
  Edit: "fs_edit",
  Glob: "fs_list",
  Bash: "fs_bash",
};

/**
 * Build-time checks for one node spec beyond its type: agent tools against
 * `allowedTools`, a function node's `fn` against `allowedFunctions`, and a
 * workshop git diff against `blockHostExec`. Used by the compiler for every
 * node and map inner node, and by map at run time.
 */
export function assertNodeSpecAllowed(policy: NodePolicy | undefined, node: { type?: unknown; with?: unknown }, where: string): void {
  if (!policy) return;
  const type = String(node.type ?? "");
  const w = (node.with ?? {}) as Record<string, unknown>;
  if (type === "agent" || type === "intelligent") {
    for (const name of registeredToolNamesOf(w.tools)) assertToolAllowed(policy, name, `${where} agent tool`);
  }
  if (type === "function" || type === "code") {
    if (typeof w.fn === "string") assertFunctionAllowed(policy, w.fn, where);
  }
  if (type === "workshop" || (type === "hitl" && w.mode === "review")) {
    const diff = w.diff as Record<string, unknown> | undefined;
    if (diff && typeof diff === "object" && diff.before == null && diff.after == null) {
      assertHostExecAllowed(policy, `${type} diff (git)`, where);
    }
  }
}

/**
 * Throws HOST_EXEC_BLOCKED for graph runtime settings that run host programs
 * from saved state: `runtime.services.rehydrateOnResume` (restarts the
 * commands recorded on `__services`) and `runtime.worktrees.cleanupOnEnd`
 * (runs `git worktree remove` on the paths recorded on `__worktrees`).
 */
export function assertGraphRuntimeAllowed(
  policy: NodePolicy | undefined,
  graph: { runtime?: { services?: { rehydrateOnResume?: boolean | undefined } | undefined; worktrees?: { cleanupOnEnd?: boolean | undefined } | undefined } | undefined },
  where: string,
): void {
  if (!policy) return;
  const refuse = (what: string) =>
    new NodePolicyError("HOST_EXEC_BLOCKED", `${where}: ${what} runs a program on the host, which is not allowed here${suffix(policy)}`);
  if (graph.runtime?.services?.rehydrateOnResume && !hostExecAllowed(policy, "service")) {
    throw refuse("runtime.services.rehydrateOnResume (restarting saved service commands)");
  }
  if (graph.runtime?.worktrees?.cleanupOnEnd && !hostExecAllowed(policy, "worktree")) {
    throw refuse("runtime.worktrees.cleanupOnEnd (git worktree remove)");
  }
}

/**
 * Under a policy, refuse graphs that declare or write the engine's reserved
 * state channels (service intents, worktree paths, agent replay, ...): what
 * lands there is later acted on as if the engine had put it there.
 */
export function assertNoReservedChannels(
  policy: NodePolicy | undefined,
  channels: Iterable<string>,
  reserved: Iterable<string>,
  where: string,
): void {
  if (!policy) return;
  const r = new Set(reserved);
  const bad = [...new Set([...channels].filter((c) => r.has(c)))];
  if (bad.length > 0) {
    throw new NodePolicyError(
      "RESERVED_CHANNEL_BLOCKED",
      `${where}: ${bad.join(", ")} ${bad.length === 1 ? "is a reserved state channel" : "are reserved state channels"}; graphs cannot declare or write them here${suffix(policy)}`,
    );
  }
}

/**
 * Whether the policy lets a run start host programs of this kind: false when
 * it blocks host exec or blocks the node type that would normally do it.
 */
export function hostExecAllowed(policy: NodePolicy | undefined, nodeType?: string): boolean {
  if (!policy) return true;
  if (policy.blockHostExec) return false;
  return !(nodeType && policy.blockedTypes?.includes(nodeType));
}

/**
 * Throws RESERVED_CHANNEL_BLOCKED when caller-supplied run input sets one of
 * the engine's reserved state channels (`__services`, `__worktrees`,
 * `__agentReplay`, …). Those are written only by the engine; accepting them
 * from input would let a caller plant services to restart, worktrees to
 * remove or replayed tool results.
 */
export function assertNoReservedInput(input: unknown, reserved: Iterable<string>, where: string): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const names = new Set(reserved);
  const hit = Object.keys(input).filter((k) => names.has(k));
  if (hit.length) {
    throw new NodePolicyError(
      "RESERVED_CHANNEL_BLOCKED",
      `${where}: input may not set reserved state channel${hit.length > 1 ? "s" : ""} ${hit.map((h) => `"${h}"`).join(", ")}`,
    );
  }
}

/** The policy a host compiled this run with, if any. */
export function nodePolicyOf(ctx: NodeRunContext | object): NodePolicy | undefined {
  return (ctx as Record<symbol, unknown>)[NODE_POLICY] as NodePolicy | undefined;
}
