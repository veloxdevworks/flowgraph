/**
 * Load-time `${VAR}` expansion in a graph's `config` and `runtime` blocks.
 * Only names the graph lists under its top-level `secrets:` are expanded.
 */

import type { Diagnostic, GraphSpec } from "@flowgraph/spec";
import { currentEnvironment } from "../environment.js";
import { undeclaredSecretMessage } from "./secret-scope.js";

export interface GraphEnvExpansion {
  /** `SECRET_UNDECLARED` for each placeholder whose name the graph (or inline subgraph) does not declare. */
  diagnostics: Diagnostic[];
  /** Values read from the host environment, registered for redaction when the graph compiles. */
  values: string[];
}

/** `$${` escapes a placeholder; matched first so an escaped one is never read. */
const PLACEHOLDER = /\$\$\{|\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g;

const expansions = new WeakMap<GraphSpec, GraphEnvExpansion>();

export function recordGraphEnvExpansion(spec: GraphSpec, expansion: GraphEnvExpansion): void {
  expansions.set(spec, expansion);
}

/** What loading this spec expanded or refused; undefined for a spec that was not loaded from a file. */
export function graphEnvExpansion(spec: GraphSpec): GraphEnvExpansion | undefined {
  return expansions.get(spec);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Expand placeholders in parsed YAML, in place: the root graph's `config` and
 * `runtime`, and those of every inline subgraph `spec:` (also under map inner
 * nodes), each against its own `secrets:` list. Undeclared placeholders stay
 * literal and are reported. Source text, keys and node bodies are never expanded.
 */
export function expandGraphEnv(
  parsed: unknown,
  out: GraphEnvExpansion = { diagnostics: [], values: [] },
  prefix = "",
): GraphEnvExpansion {
  if (!isRecord(parsed)) return out;
  const declared = new Set(Array.isArray(parsed.secrets) ? parsed.secrets.filter((s): s is string => typeof s === "string") : []);
  const env = currentEnvironment();
  const expand = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      return value.replace(PLACEHOLDER, (match, name: string | undefined, fallback: string | undefined) => {
        if (name === undefined) return "${";
        if (!declared.has(name)) {
          out.diagnostics.push({ severity: "error", code: "SECRET_UNDECLARED", path, message: undeclaredSecretMessage(name, `\`${match}\``) });
          return match;
        }
        const found = Object.hasOwn(env, name) ? env[name] : undefined;
        if (found === undefined) return fallback ?? "";
        out.values.push(found);
        return found;
      });
    }
    if (Array.isArray(value)) return value.map((item, index) => expand(item, `${path}.${index}`));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child, `${path}.${key}`)]));
    return value;
  };
  for (const key of ["config", "runtime"]) if (parsed[key] != null) parsed[key] = expand(parsed[key], `${prefix}${key}`);
  const node = (value: unknown, at: string): void => {
    if (!isRecord(value)) return;
    if (value.type === "subgraph") expandGraphEnv(value.spec, out, `${at}.spec.`);
    if (value.type === "map" && isRecord(value.with)) node(value.with.node, `${at}.with.node`);
  };
  if (Array.isArray(parsed.nodes)) {
    parsed.nodes.forEach((entry, index) => node(entry, `${prefix}nodes.${isRecord(entry) && typeof entry.id === "string" ? entry.id : index}`));
  }
  return out;
}
