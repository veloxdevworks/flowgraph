/**
 * Load-time `${VAR}` expansion in a graph's `config` and `runtime` blocks.
 * Only names the graph lists under its top-level `secrets:` are expanded.
 */

import type { Diagnostic, GraphSpec } from "@flowgraph/spec";
import { currentEnvironment } from "../environment.js";
import { undeclaredSecretMessage } from "./secret-scope.js";

type Segment = string | number;

export interface GraphEnvExpansion {
  /** `SECRET_UNDECLARED` for each placeholder whose name the graph (or inline subgraph) does not declare. */
  diagnostics: Diagnostic[];
  /** Values read from the host environment, registered for redaction when the graph compiles. */
  values: string[];
  /** Fields where `$${NAME}` was unescaped to a literal `${NAME}`, by location and name. */
  escapes: Array<{ at: Segment[]; names: string[] }>;
}

/** `$${` escapes a placeholder; matched first so an escaped one is never read. */
const PLACEHOLDER = /\$\$\{|\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g;
const ESCAPED = /\$\$\{([A-Z_][A-Z0-9_]*)/g;

const expansions = new WeakMap<GraphSpec, GraphEnvExpansion>();
/** Container object → field → names whose literal `${NAME}` came from an escape. */
const escapedFields = new WeakMap<object, Map<string, Set<string>>>();

export function recordGraphEnvExpansion(spec: GraphSpec, expansion: GraphEnvExpansion): void {
  expansions.set(spec, expansion);
  for (const { at, names } of expansion.escapes) {
    let container: unknown = spec;
    for (const segment of at.slice(0, -1)) container = isObject(container) ? (container as Record<string, unknown>)[String(segment)] : undefined;
    if (!isObject(container)) continue;
    const fields = escapedFields.get(container) ?? new Map<string, Set<string>>();
    escapedFields.set(container, fields);
    const key = String(at[at.length - 1]);
    fields.set(key, new Set([...(fields.get(key) ?? []), ...names]));
  }
}

/** What loading this spec expanded or refused; undefined for a spec that was not loaded from a file. */
export function graphEnvExpansion(spec: GraphSpec): GraphEnvExpansion | undefined {
  return expansions.get(spec);
}

function isObject(value: unknown): value is object {
  return !!value && typeof value === "object";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value);
}

function declaredSecrets(graph: Record<string, unknown>): Set<string> {
  return new Set(Array.isArray(graph.secrets) ? graph.secrets.filter((s): s is string => typeof s === "string") : []);
}

function undeclared(path: string, name: string, match: string): Diagnostic {
  return { severity: "error", code: "SECRET_UNDECLARED", path, message: undeclaredSecretMessage(name, `\`${match}\``) };
}

/**
 * Call `visit` for a graph and every inline subgraph `spec:` below it (also
 * under map inner nodes), with its display path prefix and its location.
 */
function forEachGraph(
  graph: unknown,
  visit: (graph: Record<string, unknown>, prefix: string, at: Segment[]) => void,
  prefix = "",
  at: Segment[] = [],
): void {
  if (!isRecord(graph)) return;
  visit(graph, prefix, at);
  const node = (value: unknown, path: string, where: Segment[]): void => {
    if (!isRecord(value)) return;
    if (value.type === "subgraph") forEachGraph(value.spec, visit, `${path}.spec.`, [...where, "spec"]);
    if (value.type === "map" && isRecord(value.with)) node(value.with.node, `${path}.with.node`, [...where, "with", "node"]);
  };
  if (Array.isArray(graph.nodes)) {
    graph.nodes.forEach((entry, index) =>
      node(entry, `${prefix}nodes.${isRecord(entry) && typeof entry.id === "string" ? entry.id : index}`, [...at, "nodes", index]),
    );
  }
}

/**
 * Expand placeholders in parsed YAML, in place, each graph against its own
 * `secrets:` list. Undeclared placeholders stay literal and are reported.
 * Source text, keys and node bodies are never expanded.
 */
export function expandGraphEnv(parsed: unknown): GraphEnvExpansion {
  const out: GraphEnvExpansion = { diagnostics: [], values: [], escapes: [] };
  const env = currentEnvironment();
  forEachGraph(parsed, (graph, prefix, graphAt) => {
    const declared = declaredSecrets(graph);
    const expand = (value: unknown, path: string, at: Segment[]): unknown => {
      if (typeof value === "string") {
        const escaped = [...value.matchAll(ESCAPED)].map((m) => m[1]!);
        if (escaped.length > 0) out.escapes.push({ at, names: escaped });
        return value.replace(PLACEHOLDER, (match, name: string | undefined, fallback: string | undefined) => {
          if (name === undefined) return "${";
          if (!declared.has(name)) {
            out.diagnostics.push(undeclared(path, name, match));
            return match;
          }
          const found = Object.hasOwn(env, name) ? env[name] : undefined;
          if (found === undefined) return fallback ?? "";
          out.values.push(found);
          return found;
        });
      }
      if (Array.isArray(value)) return value.map((item, index) => expand(item, `${path}.${index}`, [...at, index]));
      if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child, `${path}.${key}`, [...at, key])]));
      }
      return value;
    };
    for (const key of ["config", "runtime"]) if (graph[key] != null) graph[key] = expand(graph[key], `${prefix}${key}`, [...graphAt, key]);
  });
  return out;
}

/**
 * `SECRET_UNDECLARED` for each unexpanded `${NAME}` left in a spec's `config`
 * or `runtime` (and each inline subgraph's) whose name that graph does not
 * declare. Works on any spec, loaded or built in code; `$${NAME}` is never
 * reported, nor is a literal `${NAME}` that loading produced from one.
 */
export function unexpandedEnvDiagnostics(spec: GraphSpec): Diagnostic[] {
  const out: Diagnostic[] = [];
  forEachGraph(spec, (graph, prefix) => {
    const declared = declaredSecrets(graph);
    const visit = (value: unknown, path: string, escaped: ReadonlySet<string> | undefined): void => {
      if (typeof value === "string") {
        for (const match of value.matchAll(PLACEHOLDER)) {
          const name = match[1];
          if (name !== undefined && !declared.has(name) && !escaped?.has(name)) out.push(undeclared(path, name, match[0]));
        }
      } else if (isObject(value)) {
        const fields = escapedFields.get(value);
        for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`, fields?.get(key));
      }
    };
    for (const key of ["config", "runtime"]) visit(graph[key], `${prefix}${key}`, undefined);
  });
  return out;
}
