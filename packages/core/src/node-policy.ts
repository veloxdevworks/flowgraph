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
  /** Who set the policy, for error messages (e.g. "uploaded graphs from untrusted authors"). */
  reason?: string | undefined;
}

export type NodePolicyErrorCode =
  | "NODE_TYPE_BLOCKED"
  | "SUBGRAPH_FILE_BLOCKED"
  | "SECRET_REFERENCE_BLOCKED"
  | "OUTBOUND_ADDRESS_BLOCKED"
  | "OUTBOUND_URL_BLOCKED"
  | "MCP_BLOCKED"
  | "LOCAL_TOOLS_BLOCKED"
  | "HOST_PROBE_BLOCKED";

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

/** The policy a host compiled this run with, if any. */
export function nodePolicyOf(ctx: NodeRunContext | object): NodePolicy | undefined {
  return (ctx as Record<symbol, unknown>)[NODE_POLICY] as NodePolicy | undefined;
}
