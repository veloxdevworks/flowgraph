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
  /** Refuse node features that run a host program outside `blockedTypes`: a workshop or review `diff` that runs git. */
  blockHostExec?: boolean | undefined;
  /**
   * Refuse agent `with.agent` references, which load an AGENT.md from a path
   * or package on the host (directly, or through an operator or import alias).
   */
  blockAgentRefs?: boolean | undefined;
  /**
   * Refuse `imports` in the graph and in inline subgraphs: node, provider and
   * reducer imports load a module from the host and register what it exports
   * for the whole process.
   */
  blockImports?: boolean | undefined;
  /** Refuse inbound webhooks: wait `webhook` and `runtime.webhookServer`, which listen on a host port. */
  blockInboundWebhooks?: boolean | undefined;
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
  | "RESERVED_CHANNEL_BLOCKED"
  | "AGENT_REF_BLOCKED"
  | "IMPORTS_BLOCKED"
  | "INBOUND_WEBHOOK_BLOCKED";

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
export function assertNodeSpecAllowed(policy: NodePolicy | undefined, node: { type?: unknown; with?: unknown; input?: unknown }, where: string): void {
  if (!policy) return;
  const type = String(node.type ?? "");
  const w = (node.with ?? {}) as Record<string, unknown>;
  if (type === "agent" || type === "intelligent") {
    for (const name of registeredToolNamesOf(w.tools)) assertToolAllowed(policy, name, `${where} agent tool`);
    if (w.agent !== undefined) assertAgentRefAllowed(policy, where);
  }
  if (type === "wait" && w.webhook) assertInboundWebhookAllowed(policy, `${where} with.webhook`);
  const reservedRefs = [...reservedInputRefs(node), ...reservedStateMapRefs(node), ...reservedTemplateRefs(node)];
  if (reservedRefs.length > 0) {
    throw new NodePolicyError(
      "RESERVED_CHANNEL_BLOCKED",
      `${where}: ${reservedRefs.join(", ")} names a reserved state channel (names starting with "${RESERVED_CHANNEL_PREFIX}")${suffix(policy)}`,
    );
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
  if ((graph.runtime as { webhookServer?: unknown } | undefined)?.webhookServer !== undefined) {
    assertInboundWebhookAllowed(policy, `${where} runtime.webhookServer`);
  }
}

/** Throws INBOUND_WEBHOOK_BLOCKED under a policy that refuses inbound webhooks. */
export function assertInboundWebhookAllowed(policy: NodePolicy | undefined, where: string): void {
  if (!policy?.blockInboundWebhooks) return;
  throw new NodePolicyError(
    "INBOUND_WEBHOOK_BLOCKED",
    `${where}: an inbound webhook listens on a port on the host, which is not allowed here${suffix(policy)}`,
  );
}

/**
 * Throws IMPORTS_BLOCKED under a policy that refuses imports, for `imports`
 * on the graph or on any inline subgraph or map inner at any depth. Runs
 * before anything is loaded.
 */
export function assertImportsAllowed(policy: NodePolicy | undefined, spec: unknown, where: string): void {
  if (!policy?.blockImports) return;
  const visit = (graph: unknown, at: string, depth: number): void => {
    if (!graph || typeof graph !== "object" || depth > 32) return;
    const g = graph as { imports?: unknown; nodes?: unknown };
    if (Array.isArray(g.imports) && g.imports.length > 0) {
      throw new NodePolicyError(
        "IMPORTS_BLOCKED",
        `${at}: imports load modules from the host and register them for the whole process, which is not allowed here${suffix(policy)}`,
      );
    }
    const nodes = Array.isArray(g.nodes) ? g.nodes : [];
    const visitNode = (n: unknown, nAt: string): void => {
      if (!n || typeof n !== "object") return;
      const node = n as { id?: unknown; spec?: unknown; with?: { node?: unknown } };
      if (node.spec) visit(node.spec, `${nAt} inline subgraph`, depth + 1);
      if (node.with?.node) visitNode(node.with.node, `${nAt} inner node`);
    };
    for (const n of nodes) visitNode(n, `${at} node "${String((n as { id?: unknown })?.id ?? "?")}"`);
  };
  visit(spec, where, 0);
}

/** State channel names starting with this belong to the engine (`__services`, `__agentReplay`, ...). */
export const RESERVED_CHANNEL_PREFIX = "__";

/**
 * `text` with look-alike forms folded (NFKC, so a fullwidth `＿` is `_`) and
 * invisible format characters (zero-width spaces, joiners, bidi marks)
 * removed, so a name cannot pass a prefix check by looking different.
 */
function foldLookalikes(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

/**
 * Whether `name` is in the engine's reserved channel namespace (any `__`
 * prefix, known or not). Leading white space, look-alike underscores and
 * invisible characters count: `＿＿x` and `\u200b__x` are reserved too.
 */
export function isReservedChannel(name: string): boolean {
  return name.startsWith(RESERVED_CHANNEL_PREFIX) || foldLookalikes(name).trimStart().startsWith(RESERVED_CHANNEL_PREFIX);
}

/** A `__name` used as a whole reference or inside a `{{ }}` expression (`state.__x`, `state['__x']`). */
const RESERVED_REF_RE = /(?:^|[^A-Za-z0-9_$])__[A-Za-z0-9_$]/;
const RESERVED_REF = { test: (text: string): boolean => RESERVED_REF_RE.test(foldLookalikes(text)) };

/** `{{ ... }}` expressions inside a template string. */
const TEMPLATE_EXPR = /\{\{([\s\S]*?)\}\}/g;

/**
 * Template expressions in a node's `with` block (prompts, messages, URLs,
 * conditions, at any depth) that name a `__` channel, as `with.<path>`
 * paths. Only `{{ }}` expressions are checked, so text such as
 * `__init__.py` in a prompt is not. `stateMap` (see
 * {@link reservedStateMapRefs}) and a map's inner node (checked on its own)
 * are skipped. This is a compile-time diagnostic: expressions cannot read
 * `__` channels in any form, because `state` evaluates without them.
 */
export function reservedTemplateRefs(node: { with?: unknown }): string[] {
  const w = node.with;
  if (!w || typeof w !== "object" || Array.isArray(w)) return [];
  const out: string[] = [];
  const visit = (value: unknown, at: string, depth: number): void => {
    if (depth > 32) return;
    if (typeof value === "string") {
      for (const m of value.matchAll(TEMPLATE_EXPR)) {
        if (RESERVED_REF.test(m[1] ?? "")) {
          out.push(at);
          return;
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${at}.${i}`, depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, `${at}.${k}`, depth + 1);
    }
  };
  for (const [k, v] of Object.entries(w as Record<string, unknown>)) {
    if (k === "stateMap" || k === "node") continue;
    visit(v, `with.${k}`, 0);
  }
  return out;
}

/**
 * Reserved channel names a subgraph `stateMap` reads or writes: `in` keys
 * (child channels it fills), `in` values (parent channels it reads), `out`
 * keys (parent channels it fills) and `out` values (child channels it reads).
 * Returned as `stateMap.in.<key>`-style paths.
 */
export function reservedStateMapRefs(node: { with?: unknown }): string[] {
  const stateMap = (node.with as { stateMap?: unknown } | undefined)?.stateMap;
  if (!stateMap || typeof stateMap !== "object" || Array.isArray(stateMap)) return [];
  const out: string[] = [];
  for (const dir of ["in", "out"] as const) {
    const m = (stateMap as Record<string, unknown>)[dir];
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    for (const [key, value] of Object.entries(m as Record<string, unknown>)) {
      if (isReservedChannel(key.trim()) || (typeof value === "string" && RESERVED_REF.test(value.trim()))) {
        out.push(`stateMap.${dir}.${key}`);
      }
    }
  }
  return out;
}

/**
 * A copy of `value` without its `__` keys (or `value` itself when it has
 * none). Every place that turns caller, author, hook or model data into a
 * node's input, a subgraph's input state, an interrupt payload or a map
 * result goes through this, for trusted graphs too: `__` names are the
 * engine's, and nothing outside the engine may put a value there.
 */
export function withoutReservedKeys<T extends Record<string, unknown>>(value: T): T {
  let out: Record<string, unknown> | undefined;
  for (const k of Object.keys(value)) {
    if (!isReservedChannel(k)) continue;
    out ??= { ...value };
    delete out[k];
  }
  return (out ?? value) as T;
}

/**
 * `__` keys a node's `input` block sets and `__` names its values refer to,
 * as `input.<key>` paths. `input` becomes the node's input and, for a
 * subgraph without `stateMap.in`, part of the child's input state.
 */
export function reservedInputRefs(node: { input?: unknown }): string[] {
  const input = node.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isReservedChannel(key.trim()) || refersToReserved(value)) out.push(`input.${key}`);
  }
  return out;
}

function refersToReserved(value: unknown): boolean {
  if (typeof value === "string") return RESERVED_REF.test(value.trim());
  if (Array.isArray(value)) return value.some(refersToReserved);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => isReservedChannel(k) || refersToReserved(v));
  }
  return false;
}

/** Throws AGENT_REF_BLOCKED for `with.agent` under a policy that blocks it. */
export function assertAgentRefAllowed(policy: NodePolicy | undefined, where: string): void {
  if (!policy?.blockAgentRefs) return;
  throw new NodePolicyError(
    "AGENT_REF_BLOCKED",
    `${where}: with.agent loads an AGENT.md from a path or package on the host, which is not allowed here${suffix(policy)}`,
  );
}

/**
 * Under a policy, refuse graphs that declare or write reserved state
 * channels (any `__` name: service intents, worktree paths, agent replay,
 * ...): what lands there is later acted on as if the engine had put it there.
 */
export function assertNoReservedChannels(policy: NodePolicy | undefined, channels: Iterable<string>, where: string): void {
  if (!policy) return;
  const bad = [...new Set([...channels].filter((c) => isReservedChannel(c)))];
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
 * Throws RESERVED_CHANNEL_BLOCKED when caller-supplied run input sets a
 * reserved state channel: any name starting with `__` (`__services`,
 * `__worktrees`, `__agentReplay`, …). Those are written only by the engine; accepting them
 * from input would let a caller plant services to restart, worktrees to
 * remove or replayed tool results.
 */
export function assertNoReservedInput(input: unknown, where: string): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const hit = Object.keys(input).filter((k) => isReservedChannel(k));
  if (hit.length) {
    throw new NodePolicyError(
      "RESERVED_CHANNEL_BLOCKED",
      `${where}: input may not set reserved state channel${hit.length > 1 ? "s" : ""} ${hit.map((h) => `"${h}"`).join(", ")} (names starting with "${RESERVED_CHANNEL_PREFIX}" belong to the engine)`,
    );
  }
}

/** The policy a host compiled this run with, if any. */
export function nodePolicyOf(ctx: NodeRunContext | object): NodePolicy | undefined {
  return (ctx as Record<symbol, unknown>)[NODE_POLICY] as NodePolicy | undefined;
}
