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
  /** Strings where `$${` was unescaped, with the offset of each literal `${` that came from an escape. */
  escapes: Array<{ at: Segment[]; value: string; offsets: number[] }>;
  /** Non-empty host values substituted for declared names (not `:-default` text), for hosts that must keep them out of error text. */
  values: string[];
  /** Each whole string that one or more of those values were substituted into. */
  fields: string[];
}

/** `$${` escapes a placeholder; matched first so an escaped one is never read. */
const PLACEHOLDER = /\$\$\{|\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g;

/** Container object → field → the loaded string and the offsets of its escaped `${`. */
const escapedFields = new WeakMap<object, Map<string, { value: string; offsets: ReadonlySet<number> }>>();

export function recordGraphEnvExpansion(spec: GraphSpec, expansion: GraphEnvExpansion): void {
  for (const { at, value, offsets } of expansion.escapes) {
    let container: unknown = spec;
    for (const segment of at.slice(0, -1)) container = isObject(container) ? (container as Record<string, unknown>)[String(segment)] : undefined;
    if (!isObject(container)) continue;
    const fields = escapedFields.get(container) ?? new Map();
    escapedFields.set(container, fields);
    fields.set(String(at[at.length - 1]), { value, offsets: new Set(offsets) });
  }
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
  const out: GraphEnvExpansion = { diagnostics: [], escapes: [], values: [], fields: [] };
  const env = currentEnvironment();
  forEachGraph(parsed, (graph, prefix, graphAt) => {
    const declared = declaredSecrets(graph);
    const expand = (value: unknown, path: string, at: Segment[]): unknown => {
      if (typeof value === "string") {
        let result = "";
        let last = 0;
        const offsets: number[] = [];
        let substituted = false;
        for (const m of value.matchAll(PLACEHOLDER)) {
          const [match, name, fallback] = m;
          result += value.slice(last, m.index);
          last = m.index + match.length;
          if (name === undefined) {
            offsets.push(result.length);
            result += "${";
          } else if (!declared.has(name)) {
            out.diagnostics.push(undeclared(path, name, match));
            result += match;
          } else {
            const hostValue = Object.hasOwn(env, name) ? env[name] : undefined;
            if (hostValue) {
              out.values.push(hostValue);
              substituted = true;
            }
            result += hostValue ?? fallback ?? "";
          }
        }
        result += value.slice(last);
        if (substituted) out.fields.push(result);
        if (offsets.length > 0) out.escapes.push({ at, value: result, offsets });
        return result;
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
    const visit = (value: unknown, path: string, escaped: { value: string; offsets: ReadonlySet<number> } | undefined): void => {
      if (typeof value === "string") {
        const fromEscape = escaped?.value === value ? escaped.offsets : undefined;
        for (const match of value.matchAll(PLACEHOLDER)) {
          const name = match[1];
          if (name !== undefined && !declared.has(name) && !fromEscape?.has(match.index)) out.push(undeclared(path, name, match[0]));
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

/** Shorter expanded values are not redacted: masking `true` or `production` would corrupt unrelated run data. */
export const MIN_REDACTED_CONFIG_VALUE = 8;

function collectStrings(value: unknown, out: string[]): string[] {
  if (typeof value === "string") out.push(value);
  else if (isObject(value)) for (const child of Object.values(value)) collectStrings(child, out);
  return out;
}

/**
 * Host values of names a graph declares under `secrets:` (the root's and each
 * inline subgraph's) that appear in that graph's own `config` or `runtime`
 * strings, the only place loading could have expanded them. Re-derived from
 * the spec content, so it holds for any copy; values shorter than
 * {@link MIN_REDACTED_CONFIG_VALUE} are left out.
 */
export function expandedConfigEnvValues(spec: GraphSpec): string[] {
  const env = currentEnvironment();
  const out = new Set<string>();
  forEachGraph(spec, (graph) => {
    const strings = collectStrings([graph.config, graph.runtime], []);
    for (const name of declaredSecrets(graph)) {
      const value = Object.hasOwn(env, name) ? env[name] : undefined;
      if (value && value.length >= MIN_REDACTED_CONFIG_VALUE && strings.some((s) => s.includes(value))) out.add(value);
    }
  });
  return [...out];
}
