/**
 * What an untrusted author may upload to a multi-user server. Graphs from
 * untrusted principals may not run host commands, read host files or paths,
 * read the server's environment, reach non-public addresses, or point
 * providers at other endpoints or keys. The server checks every upload here and compiles untrusted graphs
 * with a matching core NodePolicy, so a stored graph that skipped this check
 * still cannot run a blocked node.
 */

import { classifyAddress, hostIsAllowListed, walkNodes, type NodePolicy } from "@flowgraph/core";
import { isIP } from "node:net";
import type { GraphSpec } from "@flowgraph/spec";
import { ServerRequestError } from "./errors.js";

/** Node types an untrusted upload may not contain (host commands, processes, files). */
export const UNTRUSTED_BLOCKED_NODE_TYPES: readonly string[] = ["shell", "script", "service", "worktree", "skill", "demo"];

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
  | "UPLOAD_PROVIDER_OVERRIDE_BLOCKED"
  | "UPLOAD_PROVIDER_ENDPOINT_BLOCKED"
  | "UPLOAD_HTTP_TARGET_BLOCKED"
  | "UPLOAD_HOST_PATH_BLOCKED";

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
  reason: REASON,
};

/** UNTRUSTED_NODE_POLICY with the operator's http allow list (FLOWGRAPH_UNTRUSTED_HTTP_ALLOW_HOSTS). */
export function untrustedNodePolicy(allowHosts?: readonly string[]): NodePolicy {
  if (!allowHosts?.length) return UNTRUSTED_NODE_POLICY;
  return { ...UNTRUSTED_NODE_POLICY, outboundHttp: { publicOnly: true, allowHosts } };
}

/** LangChain vendors whose default endpoint is on the server itself. */
const LOCAL_ENDPOINT_VENDORS: readonly string[] = ["ollama"];

export interface UntrustedUploadOptions {
  /** Hosts http / webhook nodes may reach even on non-public addresses. */
  allowHosts?: readonly string[] | undefined;
}

const ENV_PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/;
const SECRET_REFERENCE = /\{\{[^}]*\bsecrets?\s*(?:\.|\[)/;

/** Check an untrusted upload. `raw` is the YAML text as sent; `spec` its parse without env expansion. */
export function checkUntrustedUpload(raw: string, spec: GraphSpec, opts: UntrustedUploadOptions = {}): UploadViolation[] {
  const out: UploadViolation[] = [];
  const add = (code: UploadViolationCode, path: string, message: string) => out.push({ severity: "error", code, path, message });

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
    if ((type === "agent" || type === "intelligent") && Array.isArray(w.tools)) {
      w.tools.forEach((t, i) => {
        if (t && typeof t === "object" && "skill" in t) {
          add("UPLOAD_AGENT_SKILL_TOOL_BLOCKED", `${path}.with.tools[${i}]`, "skill tools run handlers on the server");
        }
      });
    }
    if ((type === "http" || type === "webhook") && typeof w.url === "string") {
      const why = literalUrlProblem(w.url, opts.allowHosts);
      if (why) add("UPLOAD_HTTP_TARGET_BLOCKED", `${path}.with.url`, why);
    }
    if (type === "workshop" && w.diff !== undefined && w.diff !== false) {
      add("UPLOAD_HOST_PATH_BLOCKED", `${path}.with.diff`, "workshop diff runs git in a directory on the server");
    }
  });
  return out;
}

function checkGraphLevel(
  graph: GraphSpec,
  where: string,
  add: (code: UploadViolationCode, path: string, message: string) => void,
): void {
  const defaultProvider = graph.config?.defaults?.provider;
  if (typeof defaultProvider === "string" && LOCAL_ENDPOINT_VENDORS.includes(defaultProvider) && !graph.providers?.[defaultProvider]) {
    add("UPLOAD_PROVIDER_ENDPOINT_BLOCKED", `${where}config.defaults.provider`, `vendor "${defaultProvider}" talks to a model server on the host`);
  }
  const runtime = (graph.runtime ?? {}) as Record<string, unknown>;
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
