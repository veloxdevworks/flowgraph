/**
 * What an untrusted author may upload to a multi-user server. Graphs from
 * untrusted principals may not run host commands, read host files or paths,
 * read the server's environment, reach non-public addresses, use MCP
 * servers or local tools, probe for host programs, or point providers at
 * other endpoints or keys. The server checks every upload here and compiles untrusted graphs
 * with a matching core NodePolicy, so a stored graph that skipped this check
 * still cannot run a blocked node.
 */

import {
  RESERVED_CHANNEL_PREFIX,
  classifyAddress,
  collectNodeWriteChannels,
  hostIsAllowListed,
  isReservedChannel,
  registeredToolNamesOf,
  reservedInputRefs,
  reservedStateMapRefs,
  reservedTemplateRefs,
  walkNodes,
  type NodePolicy,
} from "@flowgraph/core";
import { isIP } from "node:net";
import type { GraphSpec } from "@flowgraph/spec";
import { ServerRequestError } from "./errors.js";

/** Node types an untrusted upload may not contain (host commands, processes, files). */
export const UNTRUSTED_BLOCKED_NODE_TYPES: readonly string[] = ["shell", "script", "service", "worktree", "skill", "demo", "mcp"];

/**
 * Registered agent function tools an untrusted graph may call: asking the
 * human, and reading the status of this thread's services (which untrusted
 * graphs cannot start). Operators add their own with
 * FLOWGRAPH_UNTRUSTED_ALLOW_TOOLS. start_service, restart_service and
 * stop_service stay refused even when listed, because service nodes are.
 */
export const UNTRUSTED_ALLOWED_TOOLS: readonly string[] = ["ask_human", "list_services", "service_status"];

/** LangChain model options an untrusted upload may set; anything else could redirect the request or the key. */
export const UNTRUSTED_PROVIDER_OPTIONS: readonly string[] = [
  "temperature",
  "maxTokens",
  "maxOutputTokens",
  "topP",
  "topK",
  "stop",
  "stopSequences",
  "frequencyPenalty",
  "presencePenalty",
  "seed",
  "timeout",
  "maxRetries",
  "streaming",
  "reasoningEffort",
  "reasoning",
  "thinking",
];

export type UploadViolationCode =
  | "UPLOAD_NODE_TYPE_BLOCKED"
  | "UPLOAD_ENV_PLACEHOLDER_BLOCKED"
  | "UPLOAD_SECRET_REFERENCE_BLOCKED"
  | "UPLOAD_SUBGRAPH_FILE_BLOCKED"
  | "UPLOAD_AGENT_SKILL_TOOL_BLOCKED"
  | "UPLOAD_AGENT_TOOL_BLOCKED"
  | "UPLOAD_FUNCTION_BLOCKED"
  | "UPLOAD_PROVIDER_OVERRIDE_BLOCKED"
  | "UPLOAD_PROVIDER_ENDPOINT_BLOCKED"
  | "UPLOAD_HTTP_TARGET_BLOCKED"
  | "UPLOAD_MCP_BLOCKED"
  | "UPLOAD_LOCAL_TOOLS_BLOCKED"
  | "UPLOAD_HOST_PROBE_BLOCKED"
  | "UPLOAD_HOST_PATH_BLOCKED"
  | "UPLOAD_RUNTIME_HOST_EXEC_BLOCKED"
  | "UPLOAD_RESERVED_CHANNEL_BLOCKED"
  | "UPLOAD_AGENT_REF_BLOCKED"
  | "UPLOAD_IMPORTS_BLOCKED"
  | "UPLOAD_INBOUND_WEBHOOK_BLOCKED";

/** Why a reserved name is refused (every `__` name belongs to the engine: service intents, worktree paths, agent replay, ...). */
const RESERVED_WHY = `names starting with "${RESERVED_CHANNEL_PREFIX}" are reserved state channels`;

export interface UploadViolation {
  severity: "error";
  code: UploadViolationCode;
  message: string;
  path: string;
}

const REASON = "uploaded graphs from untrusted authors";

/** The core policy the server compiles untrusted graphs with (no host allow list). */
export const UNTRUSTED_NODE_POLICY: NodePolicy = {
  blockedTypes: UNTRUSTED_BLOCKED_NODE_TYPES,
  blockSubgraphFiles: true,
  blockSecrets: true,
  outboundHttp: { publicOnly: true },
  blockMcp: true,
  blockLocalTools: true,
  blockHostProbes: true,
  allowedTools: UNTRUSTED_ALLOWED_TOOLS,
  allowedFunctions: [],
  blockHostExec: true,
  blockAgentRefs: true,
  blockImports: true,
  blockInboundWebhooks: true,
  reason: REASON,
};

/**
 * UNTRUSTED_NODE_POLICY plus the operator's allow lists: http hosts
 * (FLOWGRAPH_UNTRUSTED_HTTP_ALLOW_HOSTS), agent tools
 * (FLOWGRAPH_UNTRUSTED_ALLOW_TOOLS) and registered functions
 * (FLOWGRAPH_UNTRUSTED_ALLOW_FUNCTIONS). A bare array is the http host list.
 */
export function untrustedNodePolicy(opts: UntrustedUploadOptions | readonly string[] = {}): NodePolicy {
  const o: UntrustedUploadOptions = Array.isArray(opts) ? { allowHosts: opts as readonly string[] } : (opts as UntrustedUploadOptions);
  const policy: NodePolicy = { ...UNTRUSTED_NODE_POLICY };
  if (o.allowHosts?.length) policy.outboundHttp = { publicOnly: true, allowHosts: o.allowHosts };
  if (o.allowTools?.length) policy.allowedTools = [...UNTRUSTED_ALLOWED_TOOLS, ...o.allowTools];
  if (o.allowFunctions?.length) policy.allowedFunctions = [...o.allowFunctions];
  return policy;
}

/** LangChain vendors whose default endpoint is on the server itself. */
const LOCAL_ENDPOINT_VENDORS: readonly string[] = ["ollama"];

export interface UntrustedUploadOptions {
  /** Hosts http / webhook nodes may reach even on non-public addresses. */
  allowHosts?: readonly string[] | undefined;
  /** Registered agent function tools allowed beyond UNTRUSTED_ALLOWED_TOOLS. */
  allowTools?: readonly string[] | undefined;
  /** Registered functions `function` nodes may call. Default: none. */
  allowFunctions?: readonly string[] | undefined;
}

const ENV_PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/;
const SECRET_REFERENCE = /\{\{[^}]*\bsecrets?\s*(?:\.|\[)/;

/** Check an untrusted upload. `raw` is the YAML text as sent; `spec` its parse without env expansion. */
export function checkUntrustedUpload(raw: string, spec: GraphSpec, opts: UntrustedUploadOptions = {}): UploadViolation[] {
  const out: UploadViolation[] = [];
  const add = (code: UploadViolationCode, path: string, message: string) => out.push({ severity: "error", code, path, message });
  const policy = untrustedNodePolicy(opts);
  const allowedTools = policy.allowedTools ?? [];
  const allowedFunctions = policy.allowedFunctions ?? [];

  raw.split("\n").forEach((line, i) => {
    const m = ENV_PLACEHOLDER.exec(line);
    if (m) {
      add(
        "UPLOAD_ENV_PLACEHOLDER_BLOCKED",
        `line ${i + 1}`,
        `${m[0]} would read the server's environment; pass the value as run input instead`,
      );
    }
  });

  walkStrings(spec, "", (value, path) => {
    if (SECRET_REFERENCE.test(value)) {
      add("UPLOAD_SECRET_REFERENCE_BLOCKED", path, "secret.* templates read the server's environment; pass the value as run input instead");
    }
  });

  for (const [graph, where] of graphsIn(spec)) {
    checkGraphLevel(graph, where, add);
  }

  walkNodes(spec, (node, path) => {
    const n = node as Record<string, unknown>;
    const type = String(n.type ?? "");
    if (UNTRUSTED_BLOCKED_NODE_TYPES.includes(type)) {
      add("UPLOAD_NODE_TYPE_BLOCKED", path, `node type "${type}" runs host commands or processes`);
    }
    if (type === "subgraph" && typeof n.uses === "string" && n.uses) {
      add("UPLOAD_SUBGRAPH_FILE_BLOCKED", path, `subgraph uses "${n.uses}" loads a file from the server; embed it with spec: instead`);
    }
    if (typeof n.workspace === "string" && n.workspace) {
      add("UPLOAD_HOST_PATH_BLOCKED", `${path}.workspace`, "a node workspace is a path on the server");
    }
    const w = (n.with ?? {}) as Record<string, unknown>;
    if ((type === "agent" || type === "intelligent") && w.agent !== undefined) {
      add("UPLOAD_AGENT_REF_BLOCKED", `${path}.with.agent`, "with.agent loads an AGENT.md from a path or package on the server; put the instructions in with.system instead");
    }
    if (type === "wait" && w.webhook) {
      add("UPLOAD_INBOUND_WEBHOOK_BLOCKED", `${path}.with.webhook`, "an inbound webhook listens on a port on the server; use a signal wait and resume the run instead");
    }
    // A node's input (map inner nodes included) becomes its input and, for a
    // subgraph, the child's input state.
    for (const ref of reservedInputRefs(n)) {
      add("UPLOAD_RESERVED_CHANNEL_BLOCKED", `${path}.${ref}`, `${ref} sets or reads a reserved state channel (${RESERVED_WHY})`);
    }
    for (const ref of reservedTemplateRefs(n)) {
      add("UPLOAD_RESERVED_CHANNEL_BLOCKED", `${path}.${ref}`, `${ref} reads a reserved state channel (${RESERVED_WHY})`);
    }
    for (const ref of reservedStateMapRefs(n)) {
      add("UPLOAD_RESERVED_CHANNEL_BLOCKED", `${path}.with.${ref}`, `${ref} names a reserved state channel (${RESERVED_WHY})`);
    }
    if ((type === "agent" || type === "intelligent") && Array.isArray(w.tools)) {
      w.tools.forEach((t, i) => {
        if (t && typeof t === "object" && "skill" in t) {
          add("UPLOAD_AGENT_SKILL_TOOL_BLOCKED", `${path}.with.tools[${i}]`, "skill tools run handlers on the server");
        }
        if (t && typeof t === "object" && "mcp" in t) {
          add("UPLOAD_MCP_BLOCKED", `${path}.with.tools[${i}]`, "MCP tools connect to servers or start processes on the host");
        }
        for (const name of registeredToolNamesOf([t])) {
          if (!allowedTools.includes(name)) {
            add(
              "UPLOAD_AGENT_TOOL_BLOCKED",
              `${path}.with.tools[${i}]`,
              `tool function "${name}" runs server code untrusted graphs may not call (allowed: ${allowedTools.join(", ")})`,
            );
          }
        }
      });
    }
    if ((type === "function" || type === "code") && typeof w.fn === "string" && !allowedFunctions.includes(w.fn)) {
      add("UPLOAD_FUNCTION_BLOCKED", `${path}.with.fn`, `registered function "${w.fn}" runs server code untrusted graphs may not call`);
    }
    if (w.requires !== undefined) {
      add("UPLOAD_HOST_PROBE_BLOCKED", `${path}.with.requires`, "requires checks which programs are installed on the server");
    }
    if ((type === "http" || type === "webhook") && typeof w.url === "string") {
      const why = literalUrlProblem(w.url, opts.allowHosts);
      if (why) add("UPLOAD_HTTP_TARGET_BLOCKED", `${path}.with.url`, why);
    }
    const diff = w.diff as Record<string, unknown> | undefined;
    const diffNode = type === "workshop" ? "workshop" : type === "hitl" && w.mode === "review" ? "review" : undefined;
    if (diffNode && diff && typeof diff === "object" && diff.before == null && diff.after == null) {
      add("UPLOAD_HOST_PATH_BLOCKED", `${path}.with.diff`, `${diffNode} diff runs git in a directory on the server; pass before/after text instead`);
    }
    for (const channel of collectNodeWriteChannels(node as Parameters<typeof collectNodeWriteChannels>[0])) {
      if (isReservedChannel(channel)) {
        add("UPLOAD_RESERVED_CHANNEL_BLOCKED", `${path}.with.output`, `"${channel}": ${RESERVED_WHY}`);
      }
    }
  });
  return out;
}

function checkGraphLevel(
  graph: GraphSpec,
  where: string,
  add: (code: UploadViolationCode, path: string, message: string) => void,
): void {
  if (graph.mcpServers && Object.keys(graph.mcpServers).length > 0) {
    add("UPLOAD_MCP_BLOCKED", `${where}mcpServers`, "mcpServers connect to servers or start processes on the host");
  }
  if (graph.localTools !== undefined) {
    add("UPLOAD_LOCAL_TOOLS_BLOCKED", `${where}localTools`, "localTools run tool code on the server");
  }
  const defaultProvider = graph.config?.defaults?.provider;
  if (typeof defaultProvider === "string" && LOCAL_ENDPOINT_VENDORS.includes(defaultProvider) && !graph.providers?.[defaultProvider]) {
    add("UPLOAD_PROVIDER_ENDPOINT_BLOCKED", `${where}config.defaults.provider`, `vendor "${defaultProvider}" talks to a model server on the host`);
  }
  for (const channel of Object.keys(graph.state?.channels ?? {})) {
    if (isReservedChannel(channel)) {
      add("UPLOAD_RESERVED_CHANNEL_BLOCKED", `${where}state.channels.${channel}`, `"${channel}": ${RESERVED_WHY}`);
    }
  }
  for (const key of Object.keys((graph as { input?: Record<string, unknown> }).input ?? {})) {
    if (isReservedChannel(key)) {
      add("UPLOAD_RESERVED_CHANNEL_BLOCKED", `${where}input.${key}`, `"${key}": ${RESERVED_WHY}`);
    }
  }
  // Parsing strips imports; a spec handed over some other way is checked here.
  const imports = (graph as { imports?: unknown }).imports;
  if (Array.isArray(imports) && imports.length > 0) {
    add("UPLOAD_IMPORTS_BLOCKED", `${where}imports`, "imports load modules on the server and register them for the whole process");
  }
  const runtime = (graph.runtime ?? {}) as Record<string, unknown>;
  if (runtime.webhookServer !== undefined) {
    add("UPLOAD_INBOUND_WEBHOOK_BLOCKED", `${where}runtime.webhookServer`, "runtime.webhookServer listens on a port on the server");
  }
  const services = runtime.services as { rehydrateOnResume?: unknown } | undefined;
  if (services?.rehydrateOnResume) {
    add(
      "UPLOAD_RUNTIME_HOST_EXEC_BLOCKED",
      `${where}runtime.services.rehydrateOnResume`,
      "rehydrateOnResume restarts saved service commands on the server",
    );
  }
  const cleanup = runtime.worktrees as { cleanupOnEnd?: unknown } | undefined;
  if (cleanup?.cleanupOnEnd) {
    add("UPLOAD_RUNTIME_HOST_EXEC_BLOCKED", `${where}runtime.worktrees.cleanupOnEnd`, "cleanupOnEnd runs git worktree remove on the server");
  }
  if (typeof runtime.workspace === "string" && runtime.workspace) {
    add("UPLOAD_HOST_PATH_BLOCKED", `${where}runtime.workspace`, "runtime.workspace is a path on the server");
  }
  const worktrees = runtime.worktrees as { root?: unknown } | undefined;
  if (typeof worktrees?.root === "string" && worktrees.root) {
    add("UPLOAD_HOST_PATH_BLOCKED", `${where}runtime.worktrees.root`, "runtime.worktrees.root is a path on the server");
  }
  for (const [name, cfg] of Object.entries(graph.providers ?? {})) {
    const c = cfg as Record<string, unknown>;
    const at = `${where}providers.${name}`;
    if (c.baseUrl !== undefined) add("UPLOAD_PROVIDER_ENDPOINT_BLOCKED", `${at}.baseUrl`, `providers.${name}.baseUrl points the provider at another endpoint`);
    if (typeof c.vendor === "string" && LOCAL_ENDPOINT_VENDORS.includes(c.vendor)) {
      add("UPLOAD_PROVIDER_ENDPOINT_BLOCKED", `${at}.vendor`, `vendor "${c.vendor}" talks to a model server on the host`);
    }
    for (const key of ["apiKeyEnv", "cwd"] as const) {
      if (c[key] !== undefined) add("UPLOAD_PROVIDER_OVERRIDE_BLOCKED", `${at}.${key}`, `providers.${name}.${key} is set by the server operator`);
    }
    const options = c.options;
    if (options && typeof options === "object") {
      for (const key of Object.keys(options)) {
        if (!UNTRUSTED_PROVIDER_OPTIONS.includes(key)) {
          add(
            "UPLOAD_PROVIDER_OVERRIDE_BLOCKED",
            `${at}.options.${key}`,
            `provider option "${key}" is not allowed (allowed: ${UNTRUSTED_PROVIDER_OPTIONS.join(", ")})`,
          );
        }
      }
    }
  }
}

/**
 * Why a literal http / webhook URL is refused at upload, or undefined. URLs
 * with templates are checked only when the request is made.
 */
function literalUrlProblem(raw: string, allowHosts: readonly string[] | undefined): string | undefined {
  if (raw.includes("{{")) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol} URLs may not be fetched; use http or https`;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) {
    const v = classifyAddress(host);
    if (v.blocked && (v.always || !hostIsAllowListed(url, allowHosts))) return `${host} is a ${v.reason} address; only public addresses may be reached`;
    return undefined;
  }
  if ((host === "localhost" || host.endsWith(".localhost")) && !hostIsAllowListed(url, allowHosts)) {
    return `${host} is the server itself; only public addresses may be reached`;
  }
  return undefined;
}

/** The root spec and every inline subgraph spec, with a path prefix. */
function graphsIn(spec: GraphSpec): Array<[GraphSpec, string]> {
  const out: Array<[GraphSpec, string]> = [[spec, ""]];
  walkNodes(spec, (node, path) => {
    const inline = (node as { type?: unknown; spec?: GraphSpec }).spec;
    if ((node as { type?: unknown }).type === "subgraph" && inline && typeof inline === "object") out.push([inline, `${path}.spec.`]);
  });
  return out;
}

function walkStrings(v: unknown, path: string, visit: (value: string, path: string) => void, depth = 0): void {
  if (depth > 64) return;
  if (typeof v === "string") return visit(v, path || "(root)");
  if (Array.isArray(v)) return v.forEach((x, i) => walkStrings(x, `${path}[${i}]`, visit, depth + 1));
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) walkStrings(x, path ? `${path}.${k}` : k, visit, depth + 1);
  }
}

/** Refuse an untrusted upload with every violation listed. */
export function assertUntrustedUploadAllowed(raw: string, spec: GraphSpec, opts: UntrustedUploadOptions = {}): void {
  const violations = checkUntrustedUpload(raw, spec, opts);
  if (violations.length === 0) return;
  const first = violations[0]!;
  const more = violations.length > 1 ? ` (and ${violations.length - 1} more)` : "";
  throw new ServerRequestError(403, first.code, `Graph not allowed for an untrusted author: ${first.path}: ${first.message}${more}`, violations);
}
