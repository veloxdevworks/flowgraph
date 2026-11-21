/**
 * Validate-time checks that a graph reads only the host environment variables
 * it declares under the top-level `secrets:` list.
 */

import type { Diagnostic, GraphSpec } from "@flowgraph/spec";
import { templateRootRefs } from "../node-policy.js";
import { getMediaVendor } from "../media/registry.js";
import { defaultLangChainApiKeyEnv } from "../providers/langchain/factory.js";
import { undeclaredBaseUrlKeyMessage, undeclaredSecretMessage } from "./secret-scope.js";

const SECRET_ROOT = new Set(["secret"]);
const NAMED_SECRET = /^secret(?:\.([A-Za-z_$][\w$]*)|\[("(?:[^"\\]|\\.)*")\])/;

/** The literal names `{{ secret.X }}` / `{{ secret["X"] }}` read in `text`. Computed names are checked at run time. */
export function secretNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const ref of templateRootRefs(text, SECRET_ROOT)) {
    const match = NAMED_SECRET.exec(ref);
    if (!match) continue;
    names.push(match[1] ?? (JSON.parse(match[2]!) as string));
  }
  return names;
}

function graphDiagnostics(spec: GraphSpec, prefix: string, out: Diagnostic[]): void {
  const declared = new Set(spec.secrets ?? []);
  const visit = (value: unknown, path: string, where: string, depth: number): void => {
    if (depth > 64) return;
    if (typeof value === "string") {
      for (const name of new Set(secretNamesIn(value))) {
        if (!declared.has(name)) out.push({ severity: "error", code: "SECRET_UNDECLARED", path, message: undeclaredSecretMessage(name, where) });
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}.${index}`, where, depth + 1));
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`, where, depth + 1);
    }
  };
  for (const [name, server] of Object.entries(spec.mcpServers ?? {})) {
    visit(server, `${prefix}mcpServers.${name}`, `MCP server "${name}"`, 0);
  }
  for (const node of spec.nodes ?? []) {
    const at = `${prefix}nodes.${node.id}`;
    for (const [key, value] of Object.entries(node)) {
      if (key !== "spec") visit(value, `${at}.${key}`, `Node "${node.id}"`, 0);
    }
    if (node.spec && typeof node.spec === "object") graphDiagnostics(node.spec, `${at}.spec.`, out);
  }
}

/**
 * `SECRET_UNDECLARED` for every `{{ secret.X }}` in nodes and `mcpServers`
 * whose name the graph (or inline subgraph) does not declare.
 */
export function secretReferenceDiagnostics(spec: GraphSpec): Diagnostic[] {
  const out: Diagnostic[] = [];
  graphDiagnostics(spec, "", out);
  return out;
}

/**
 * `SECRET_UNDECLARED` for a provider `apiKeyEnv` the graph does not declare,
 * and for a provider with a `baseUrl` whose default key the graph does not
 * declare, since that key is sent to the graph's chosen endpoint.
 */
export function providerSecretDiagnostics(spec: GraphSpec): Diagnostic[] {
  const declared = new Set(spec.secrets ?? []);
  const out: Diagnostic[] = [];
  for (const [name, cfg] of Object.entries(spec.providers ?? {})) {
    if (!cfg || typeof cfg !== "object") continue;
    const apiKeyEnv = "apiKeyEnv" in cfg ? cfg.apiKeyEnv : undefined;
    if (apiKeyEnv !== undefined) {
      if (!declared.has(apiKeyEnv)) {
        out.push({ severity: "error", code: "SECRET_UNDECLARED", path: `providers.${name}.apiKeyEnv`, message: undeclaredSecretMessage(apiKeyEnv, `Provider "${name}" apiKeyEnv`) });
      }
      continue;
    }
    if (!("baseUrl" in cfg) || cfg.baseUrl === undefined) continue;
    const key = cfg.kind === "langchain"
      ? defaultLangChainApiKeyEnv(cfg.vendor)
      : cfg.kind === "media" ? getMediaVendor(cfg.vendor)?.defaultApiKeyEnv : undefined;
    if (key && !declared.has(key)) {
      out.push({ severity: "error", code: "SECRET_UNDECLARED", path: `providers.${name}.baseUrl`, message: undeclaredBaseUrlKeyMessage(name, key) });
    }
  }
  return out;
}
