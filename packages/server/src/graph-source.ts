/**
 * v1 graph-source: accept graph YAML from the client, persist, and compile
 * server-side. Custom `imports` (nodes/providers/reducers modules) are NOT
 * executed from client uploads for security — only built-in node types and
 * server-configured / YAML-declared providers are supported.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  normalizeNodeTypeAliases,
  validateSpec,
} from "@veloxdevworks/flowgraph-core";
import { GraphSpecSchema, type GraphSpec, type Diagnostic } from "@veloxdevworks/flowgraph-spec";
import type { PersistedGraph } from "./types.js";

export interface ParseGraphYamlResult {
  spec: GraphSpec | null;
  yaml: string;
  diagnostics: Diagnostic[];
  /** True when the client YAML contained an `imports` block that was stripped. */
  importsStripped: boolean;
}

function expandEnvVars(yaml: string): string {
  return yaml.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g, (_m, name: string, def: string) => {
    return process.env[name] ?? def ?? "";
  });
}

/**
 * Parse uploaded YAML into a GraphSpec. Strips `imports` so client code
 * modules are never loaded.
 */
export function parseGraphYaml(raw: string): ParseGraphYamlResult {
  const expanded = expandEnvVars(raw);
  let parsed: unknown;
  try {
    parsed = parseYaml(expanded);
  } catch (err) {
    return {
      spec: null,
      yaml: raw,
      diagnostics: [
        {
          severity: "error",
          code: "YAML_PARSE_ERROR",
          message: `YAML parse error: ${String(err)}`,
        },
      ],
      importsStripped: false,
    };
  }

  parsed = normalizeNodeTypeAliases(parsed);
  let importsStripped = false;

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.imports) && obj.imports.length > 0) {
      importsStripped = true;
      delete obj.imports;
    }
  }

  const result = GraphSpecSchema.safeParse(parsed);
  if (!result.success) {
    return {
      spec: null,
      yaml: raw,
      diagnostics: result.error.issues.map((i) => ({
        severity: "error" as const,
        code: "SCHEMA_ERROR",
        message: `${i.path.join(".")}: ${i.message}`,
        path: i.path.join("."),
      })),
      importsStripped,
    };
  }

  const lint = validateSpec(result.data);
  const errors = lint.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    return {
      spec: null,
      yaml: stringifyYaml(result.data),
      diagnostics: lint,
      importsStripped,
    };
  }

  const yaml = stringifyYaml(result.data);
  return { spec: result.data, yaml, diagnostics: lint, importsStripped };
}

export async function ensureGraphStoreDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function graphPathFor(dir: string, threadId: string): string {
  const safe = threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(dir, `${safe}.graph.yaml`);
}

export async function persistGraph(
  dir: string,
  threadId: string,
  yaml: string,
  spec: GraphSpec,
): Promise<PersistedGraph> {
  await ensureGraphStoreDir(dir);
  const filePath = graphPathFor(dir, threadId);
  await fs.writeFile(filePath, yaml, "utf-8");
  const stored: PersistedGraph = {
    threadId,
    yaml,
    spec,
    storedAt: new Date().toISOString(),
  };
  await fs.writeFile(`${filePath}.meta.json`, JSON.stringify({ threadId, storedAt: stored.storedAt }), "utf-8");
  return stored;
}

export async function loadPersistedGraph(
  dir: string,
  threadId: string,
): Promise<{ yaml: string; spec: GraphSpec } | null> {
  const filePath = graphPathFor(dir, threadId);
  try {
    const yaml = await fs.readFile(filePath, "utf-8");
    const parsed = parseGraphYaml(yaml);
    if (!parsed.spec) return null;
    return { yaml: parsed.yaml, spec: parsed.spec };
  } catch {
    return null;
  }
}
