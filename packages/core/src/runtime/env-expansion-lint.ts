/**
 * Lint for load-time `${ENV}` expansion colliding with shell node bodies.
 *
 * `loadGraph` rewrites `${UPPER_CASE}` / `${UPPER_CASE:-default}` against
 * `process.env` over the entire YAML text before parse. That is intended for
 * `config`/`runtime` scalars, but the same rewrite silently empties shell
 * `command`/`args`/`env` strings that use braced POSIX vars (e.g. `${SLUG}`).
 * Those must be scanned on the *raw* YAML — after expandEnvVars the evidence
 * is already gone.
 */

import { parse as parseYaml } from "yaml";
import type { Diagnostic } from "@veloxdevworks/flowgraph-spec";

/** Same pattern as `expandEnvVars` in loader.ts. */
export const LOAD_TIME_ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g;

export const NODE_BODY_ENV_EXPANSION = "NODE_BODY_ENV_EXPANSION";

function findMatches(text: string): Array<{ name: string; match: string }> {
  const found: Array<{ name: string; match: string }> = [];
  const re = new RegExp(LOAD_TIME_ENV_VAR_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.push({ name: m[1]!, match: m[0]! });
  }
  return found;
}

function pushForText(
  diagnostics: Diagnostic[],
  nodeId: string,
  fieldPath: string,
  text: string,
): void {
  for (const { name, match } of findMatches(text)) {
    diagnostics.push({
      severity: "warning",
      code: NODE_BODY_ENV_EXPANSION,
      message:
        `Shell node "${nodeId}" ${fieldPath} contains ${match}, which is rewritten ` +
        `against the host process environment at graph-load time (usually to empty) ` +
        `before the node runs or its own with.env applies. Use unbraced $${name} ` +
        `for node-level env vars, or {{ state.* }} for runtime data.`,
      path: `nodes.${nodeId}.with.${fieldPath}`,
    });
  }
}

/**
 * Scan raw (unexpanded) graph YAML for `${UPPER_CASE}` inside shell node
 * `command` / `args` / `env` values. Returns warnings; never throws on bad YAML.
 */
export function envExpansionCollisionDiagnostics(raw: string): Diagnostic[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];

  const nodes = (parsed as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];

  const diagnostics: Diagnostic[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    if (n.type !== "shell") continue;
    const id = typeof n.id === "string" && n.id.trim() ? n.id : "(anonymous)";
    const withBlock = n.with;
    if (!withBlock || typeof withBlock !== "object" || Array.isArray(withBlock)) continue;
    const w = withBlock as Record<string, unknown>;

    if (typeof w.command === "string") {
      pushForText(diagnostics, id, "command", w.command);
    }
    if (Array.isArray(w.args)) {
      for (let i = 0; i < w.args.length; i++) {
        const arg = w.args[i];
        if (typeof arg === "string") {
          pushForText(diagnostics, id, `args[${i}]`, arg);
        }
      }
    }
    if (w.env != null && typeof w.env === "object" && !Array.isArray(w.env)) {
      for (const [key, val] of Object.entries(w.env as Record<string, unknown>)) {
        if (typeof val === "string") {
          pushForText(diagnostics, id, `env.${key}`, val);
        }
      }
    }
  }
  return diagnostics;
}
