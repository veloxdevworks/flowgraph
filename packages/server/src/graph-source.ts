/**
 * v1 graph-source: accept graph YAML from the client, persist, and compile
 * server-side. Custom `imports` (nodes/providers/reducers modules) are NOT
 * executed from client uploads for security — only built-in node types and
 * server-configured / YAML-declared providers are supported.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  normalizeNodeTypeAliases,
  validateSpec,
} from "@flowgraph/core";
import { GraphSpecSchema, type GraphSpec, type Diagnostic } from "@flowgraph/spec";
import { errorFields, log } from "./metrics.js";
import type { GraphMeta, PersistedGraph, RunStatus, ServerEvent, ThreadOwner } from "./types.js";

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

export function safeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function graphPathFor(dir: string, threadId: string): string {
  return path.join(dir, `${safeThreadId(threadId)}.graph.yaml`);
}

export function eventJournalPath(dir: string, threadId: string): string {
  return path.join(dir, `${safeThreadId(threadId)}.events.jsonl`);
}

/** Append one engine event to the on-disk journal. Best-effort. */
export function appendEventJournal(dir: string, threadId: string, event: ServerEvent): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(eventJournalPath(dir, threadId), `${JSON.stringify(event)}\n`, "utf8");
  } catch (err) {
    log("warn", "event.journal.append.failed", { threadId, ...errorFields(err) });
  }
}

/** Load persisted SSE/engine events for a thread (empty if missing). */
export function loadEventJournal(dir: string, threadId: string): ServerEvent[] {
  const filePath = eventJournalPath(dir, threadId);
  if (!existsSync(filePath)) return [];
  try {
    const text = readFileSync(filePath, "utf8");
    const events: ServerEvent[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as ServerEvent);
      } catch {
        // skip corrupt line
      }
    }
    return events;
  } catch (err) {
    log("warn", "event.journal.read.failed", { threadId, ...errorFields(err) });
    return [];
  }
}

export async function persistGraph(
  dir: string,
  threadId: string,
  yaml: string,
  spec: GraphSpec,
  extras: { label?: string; status?: RunStatus; owner?: ThreadOwner } = {},
): Promise<PersistedGraph> {
  await ensureGraphStoreDir(dir);
  const filePath = graphPathFor(dir, threadId);
  await fs.writeFile(filePath, yaml, "utf-8");
  const now = new Date().toISOString();
  const existing = await readGraphMeta(dir, threadId);
  const storedAt = existing?.storedAt ?? now;
  const meta: GraphMeta = {
    threadId,
    storedAt,
    updatedAt: now,
    graphName: spec.metadata?.name ?? "graph",
    ...((extras.label ?? existing?.label) ? { label: (extras.label ?? existing?.label) as string } : {}),
    status: extras.status ?? existing?.status ?? "started",
    // The first owner sticks: callers check ownership before persisting.
    ...((existing?.owner ?? extras.owner) ? { owner: (existing?.owner ?? extras.owner) as ThreadOwner } : {}),
  };
  await writeGraphMeta(dir, threadId, meta);
  return {
    threadId,
    yaml,
    spec,
    storedAt,
    updatedAt: now,
    ...(meta.label ? { label: meta.label } : {}),
    ...(meta.graphName ? { graphName: meta.graphName } : {}),
    ...(meta.status ? { status: meta.status } : {}),
  };
}

function metaPathFor(dir: string, threadId: string): string {
  return `${graphPathFor(dir, threadId)}.meta.json`;
}

async function writeGraphMeta(dir: string, threadId: string, meta: GraphMeta): Promise<void> {
  await fs.writeFile(metaPathFor(dir, threadId), JSON.stringify(meta), "utf-8");
}

function isThreadOwner(v: unknown): v is ThreadOwner {
  return Boolean(v && typeof v === "object" && typeof (v as ThreadOwner).id === "string" && typeof (v as ThreadOwner).org === "string");
}

export async function readGraphMeta(dir: string, threadId: string): Promise<GraphMeta | null> {
  try {
    const raw = await fs.readFile(metaPathFor(dir, threadId), "utf-8");
    const parsed = JSON.parse(raw) as Partial<GraphMeta>;
    if (!parsed || typeof parsed.threadId !== "string") {
      return { threadId, storedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    }
    const storedAt = typeof parsed.storedAt === "string" ? parsed.storedAt : new Date().toISOString();
    return {
      threadId: parsed.threadId,
      storedAt,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : storedAt,
      ...(typeof parsed.label === "string" ? { label: parsed.label } : {}),
      ...(typeof parsed.graphName === "string" ? { graphName: parsed.graphName } : {}),
      ...(typeof parsed.status === "string" ? { status: parsed.status as RunStatus } : {}),
      ...(isThreadOwner(parsed.owner) ? { owner: { id: parsed.owner.id, org: parsed.owner.org } } : {}),
    };
  } catch {
    return null;
  }
}

export async function updateGraphMeta(
  dir: string,
  threadId: string,
  patch: Partial<Pick<GraphMeta, "label" | "status" | "graphName">>,
): Promise<GraphMeta | null> {
  const existing = await readGraphMeta(dir, threadId);
  if (!existing) return null;
  const next: GraphMeta = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeGraphMeta(dir, threadId, next);
  return next;
}

export async function loadPersistedGraph(
  dir: string,
  threadId: string,
): Promise<{ yaml: string; spec: GraphSpec; meta: GraphMeta | null } | null> {
  const filePath = graphPathFor(dir, threadId);
  try {
    const yaml = await fs.readFile(filePath, "utf-8");
    const parsed = parseGraphYaml(yaml);
    if (!parsed.spec) return null;
    const meta = await readGraphMeta(dir, threadId);
    return { yaml: parsed.yaml, spec: parsed.spec, meta };
  } catch {
    return null;
  }
}

/** List persisted run metadata (graph store + `.meta.json` files). */
export async function listPersistedGraphs(dir: string): Promise<GraphMeta[]> {
  try {
    await ensureGraphStoreDir(dir);
    const names = await fs.readdir(dir);
    const metas: GraphMeta[] = [];
    for (const name of names) {
      if (!name.endsWith(".graph.yaml.meta.json")) continue;
      const threadId = name.slice(0, -".graph.yaml.meta.json".length);
      const meta = await readGraphMeta(dir, threadId);
      if (meta) metas.push(meta);
    }
    metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return metas;
  } catch {
    return [];
  }
}
