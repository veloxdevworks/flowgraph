/**
 * Host-set limits on what a graph may run. A multi-user host (the server)
 * compiles graphs uploaded by untrusted authors with a policy that refuses
 * node types able to run host commands, and refuses subgraphs that load graph
 * files from the host's disk. The policy is checked when nodes are built
 * (compile, and again inside map and embedded subgraphs at run time) so a spec
 * that skipped the host's upload check still cannot run a blocked node.
 */

import type { NodeRunContext } from "./context.js";

/** Key of the policy on the run context (copied into every node context). */
export const NODE_POLICY = Symbol.for("flowgraph.nodePolicy");

export interface NodePolicy {
  /** Node types that may not be built or run (map inners and agent skill tools included). */
  blockedTypes?: readonly string[] | undefined;
  /** Refuse subgraph `uses` references, which load graph files from the host's disk. Inline `spec` is allowed. */
  blockSubgraphFiles?: boolean | undefined;
  /** Make `{{ secret.X }}` in http / webhook templates fail instead of reading the host environment. */
  blockSecrets?: boolean | undefined;
  /** Who set the policy, for error messages (e.g. "uploaded graphs from untrusted authors"). */
  reason?: string | undefined;
}

export type NodePolicyErrorCode = "NODE_TYPE_BLOCKED" | "SUBGRAPH_FILE_BLOCKED" | "SECRET_REFERENCE_BLOCKED";

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

/** The policy a host compiled this run with, if any. */
export function nodePolicyOf(ctx: NodeRunContext | object): NodePolicy | undefined {
  return (ctx as Record<symbol, unknown>)[NODE_POLICY] as NodePolicy | undefined;
}
