/**
 * v1 graph-source: accept graph YAML from the client, persist, and compile
 * server-side. Custom `imports` (nodes/providers/reducers modules) are NOT
 * executed from client uploads for security — only built-in node types and
 * server-configured / YAML-declared providers are supported.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  normalizeNodeTypeAliases,
  validateSpec,
} from "@flowgraph/core";
import { GraphSpecSchema, type GraphSpec, type Diagnostic } from "@flowgraph/spec";
import { ServerRequestError } from "./errors.js";
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
 * Remove `imports` from a graph and from every inline subgraph (`spec:`) and
 * map inner node below it. Returns whether anything was removed.
 */
function stripImports(graph: Record<string, unknown>, depth: number): boolean {
  if (depth > 32) return false;
  let stripped = false;
  if ("imports" in graph) {
    stripped = Array.isArray(graph.imports) ? graph.imports.length > 0 : graph.imports != null;
    delete graph.imports;
  }
  const visitNode = (node: unknown, nodeDepth: number): void => {
    if (!node || typeof node !== "object" || Array.isArray(node) || nodeDepth > 32) return;
    const n = node as { spec?: unknown; with?: { node?: unknown } };
    if (n.spec && typeof n.spec === "object" && !Array.isArray(n.spec)) {
      if (stripImports(n.spec as Record<string, unknown>, depth + 1)) stripped = true;
    }
    if (n.with && typeof n.with === "object") visitNode(n.with.node, nodeDepth + 1);
  };
  if (Array.isArray(graph.nodes)) for (const node of graph.nodes) visitNode(node, depth);
  return stripped;
}

/**
 * Parse uploaded YAML into a GraphSpec. Strips `imports` (on the graph and
 * on inline subgraphs at any depth) so client code modules are never loaded. `${VAR}` placeholders are filled from the server
 * environment unless `expandEnv` is false (untrusted uploads, stored graphs).
 */
export function parseGraphYaml(raw: string, opts: { expandEnv?: boolean } = {}): ParseGraphYamlResult {
  const expanded = opts.expandEnv === false ? raw : expandEnvVars(raw);
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
    importsStripped = stripImports(parsed as Record<string, unknown>, 0);
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

/**
 * Write `data` to a new temporary file next to `filePath` and flush it to
 * disk. Returns the temporary file's path; on failure nothing is left behind.
 */
async function stageFile(filePath: string, data: string): Promise<string> {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath).slice(0, 200)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, "wx", 0o600);
    await handle.writeFile(data, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    return tmp;
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** True for the name of a temporary file written by {@link stageFile}. */
export function isStagedFileName(name: string): boolean {
  return /^\..+\.\d+\.[0-9a-f]{12}\.tmp$/.test(name);
}

/** Suffix of a thread's meta file, which sits next to its `{id}.graph.yaml`. */
export const GRAPH_META_SUFFIX = ".graph.yaml.meta.json";

/**
 * Replace `filePath` with `data` so a reader sees either the old file or the
 * new one, never a partly written one: write a temporary file in the same
 * directory, flush it to disk, then rename it over the target.
 */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const tmp = await stageFile(filePath, data);
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  await syncDir(path.dirname(filePath));
}

/** Filesystems that cannot hard-link answer with one of these. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

/**
 * Create `filePath` holding `data`, failing with `EEXIST` when it already
 * exists, even when another process creates it at the same moment. The data
 * is written and flushed to a temporary file first, then hard-linked to the
 * target: the link fails if the target exists, and a reader never sees the
 * target partly written. Where the filesystem has no hard links, the target
 * is opened with `wx` (still exclusive) and written in place, so a reader
 * may briefly find it incomplete; readers treat that as unreadable (503),
 * not as a missing thread.
 */
export async function createFileExclusive(filePath: string, data: string): Promise<void> {
  const tmp = await stageFile(filePath, data);
  let linked = false;
  try {
    await fs.link(tmp, filePath);
    linked = true;
  } catch (err) {
    if (!NO_HARD_LINKS.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
  if (!linked) await writeNewFileInPlace(filePath, data);
  await syncDir(path.dirname(filePath));
}

async function writeNewFileInPlace(filePath: string, data: string): Promise<void> {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(data, "utf-8");
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    throw err;
  }
  await handle.close();
}

/** Flush a directory so a rename in it survives a crash. Some filesystems cannot, which is not an error. */
async function syncDir(dir: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch {
    // Not supported here (some platforms and filesystems refuse fsync on a directory).
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Test seams, passed to {@link persistGraph}. `beforeMetaCreate` runs after
 * a store has found no meta file for a new thread and before it creates one,
 * which is where another server process sharing the store can create the
 * same file first. `beforeGraphMove` runs after the meta file is created and
 * before the staged graph is moved into place, which is where another server
 * can already see the new thread and update it.
 */
export interface GraphStoreHooks {
  beforeMetaCreate?: (threadId: string, metaPath: string) => Promise<void> | void;
  beforeGraphMove?: (threadId: string, graphPath: string) => Promise<void> | void;
}

/** Meta updates in progress, by meta file path. */
const metaLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier call for the same meta file has settled, so
 * read-modify-write updates of one thread's meta apply in order and none is
 * lost. This orders writes within one process. Another process sharing the
 * directory is not ordered with these writes; creating a thread's meta file
 * is still exclusive across processes (see {@link createFileExclusive}).
 */
async function withMetaLock<T>(metaPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = metaLocks.get(metaPath) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.catch(() => undefined);
  metaLocks.set(metaPath, settled);
  void settled.then(() => {
    if (metaLocks.get(metaPath) === settled) metaLocks.delete(metaPath);
  });
  return run;
}

/**
 * A thread's meta file exists but cannot be read or parsed. Access checks
 * refuse the thread rather than treat it as never stored, which would skip
 * its owner check.
 */
export class GraphMetaUnreadableError extends ServerRequestError {
  constructor(readonly threadId: string, cause: unknown) {
    super(503, "THREAD_META_UNREADABLE", `The stored record for thread "${threadId}" cannot be read, so access is refused; try again, or ask an operator to repair it`);
    this.name = "GraphMetaUnreadableError";
    this.cause = cause;
  }
}

/**
 * Longest thread id the graph store accepts: 234, so its longest file name
 * (`{id}.graph.yaml.meta.json`) fits the usual 255-byte limit. Thread ids map
 * to file names one ASCII character per UTF-16 unit, so this counts `length`.
 * Longer ids could never be stored, so none that worked before is refused.
 */
export const MAX_THREAD_ID_LENGTH = 255 - ".graph.yaml.meta.json".length;

/**
 * Refuse a thread id the graph store cannot hold a file for (empty, longer
 * than {@link MAX_THREAD_ID_LENGTH}) with 400 INVALID_THREAD_ID, rather than
 * letting the file system error look like an unreadable stored thread.
 */
export function assertValidThreadId(threadId: string): void {
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new ServerRequestError(400, "INVALID_THREAD_ID", "threadId is required");
  }
  if (threadId.length > MAX_THREAD_ID_LENGTH) {
    throw new ServerRequestError(
      400,
      "INVALID_THREAD_ID",
      `threadId is ${threadId.length} characters; the most allowed is ${MAX_THREAD_ID_LENGTH}`,
    );
  }
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
  extras: { label?: string; status?: RunStatus; owner?: ThreadOwner; yamlFormat?: "raw"; hooks?: GraphStoreHooks } = {},
): Promise<PersistedGraph> {
  assertValidThreadId(threadId);
  await ensureGraphStoreDir(dir);
  return withMetaLock(metaPathFor(dir, threadId), () => persistGraphLocked(dir, threadId, yaml, spec, extras));
}

async function persistGraphLocked(
  dir: string,
  threadId: string,
  yaml: string,
  spec: GraphSpec,
  extras: { label?: string; status?: RunStatus; owner?: ThreadOwner; yamlFormat?: "raw"; hooks?: GraphStoreHooks },
): Promise<PersistedGraph> {
  const filePath = graphPathFor(dir, threadId);
  // Read first: an unreadable meta file must not be replaced (and its owner
  // lost) by a new upload, and neither must the file of another thread id
  // that maps to the same file name ("a/b" and "a_b"). Callers check access
  // first; this keeps the write safe if a check raced with another write.
  const existing = await readGraphMeta(dir, threadId);
  if (existing && existing.threadId !== threadId) throw threadIdTaken(threadId);
  const now = new Date().toISOString();
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
    // Describes the file just written, so it never carries over.
    ...(extras.yamlFormat ? { yamlFormat: extras.yamlFormat } : {}),
  };
  if (existing) {
    await writeFileAtomic(filePath, yaml);
    await writeGraphMeta(dir, threadId, meta);
  } else {
    await createThreadFiles(dir, threadId, filePath, yaml, meta, extras.hooks);
  }
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

function threadIdTaken(threadId: string): ServerRequestError {
  return new ServerRequestError(409, "THREAD_ID_CONFLICT", `Thread id "${threadId}" collides with another stored thread; use another id`);
}

/**
 * Store a new thread. Creating its meta file is the claim: it is exclusive
 * across processes sharing the store, so when another server created the
 * file first (for this thread id or one sharing its file name) this one gets
 * 409 THREAD_ID_CONFLICT and changes neither file. The graph is flushed to a
 * temporary file before the claim and moved into place after it, so the
 * loser never replaces the winner's graph.
 *
 * If moving the graph fails after the claim, the meta file stays. Once it
 * exists, another server may have read it and replaced it (the same owner
 * retrying elsewhere), and no check-then-delete can tell the files apart
 * without a window in which the other server's record is lost. Keeping it is
 * the state a crash at that point leaves: the thread stays claimed by the
 * requesting owner (who is already recorded in the thread owner registry),
 * other callers are refused, and the owner's next upload stores the graph.
 */
async function createThreadFiles(
  dir: string,
  threadId: string,
  filePath: string,
  yaml: string,
  meta: GraphMeta,
  hooks: GraphStoreHooks = {},
): Promise<void> {
  const metaPath = metaPathFor(dir, threadId);
  const stagedYaml = await stageFile(filePath, yaml);
  try {
    await hooks.beforeMetaCreate?.(threadId, metaPath);
    try {
      await createFileExclusive(metaPath, JSON.stringify(meta));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const winner = await readGraphMeta(dir, threadId).catch(() => null);
      log("warn", "graph meta created by another process", { threadId, path: metaPath, sameThread: winner?.threadId === threadId });
      if (winner && winner.threadId === threadId) {
        throw new ServerRequestError(409, "THREAD_ID_CONFLICT", `Thread "${threadId}" was just created by another request; retry, or use another id`);
      }
      throw threadIdTaken(threadId);
    }
    await hooks.beforeGraphMove?.(threadId, filePath);
    await fs.rename(stagedYaml, filePath);
  } catch (err) {
    await fs.rm(stagedYaml, { force: true }).catch(() => undefined);
    throw err;
  }
  await syncDir(dir);
}

function metaPathFor(dir: string, threadId: string): string {
  return `${graphPathFor(dir, threadId)}.meta.json`;
}

async function writeGraphMeta(dir: string, threadId: string, meta: GraphMeta): Promise<void> {
  await writeFileAtomic(metaPathFor(dir, threadId), JSON.stringify(meta));
}

function isThreadOwner(v: unknown): v is ThreadOwner {
  return Boolean(v && typeof v === "object" && typeof (v as ThreadOwner).id === "string" && typeof (v as ThreadOwner).org === "string");
}

/**
 * A thread's stored meta, or null when it has none (no meta file). A meta
 * file that exists but cannot be read, is not JSON, or has no thread id
 * throws {@link GraphMetaUnreadableError}: callers deciding access must not
 * take it for a thread that was never stored.
 */
export async function readGraphMeta(dir: string, threadId: string): Promise<GraphMeta | null> {
  assertValidThreadId(threadId);
  const metaPath = metaPathFor(dir, threadId);
  let parsed: Partial<GraphMeta> | null;
  try {
    parsed = JSON.parse(await fs.readFile(metaPath, "utf-8")) as Partial<GraphMeta> | null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    log("error", "graph meta unreadable", { threadId, path: metaPath, ...errorFields(err) });
    throw new GraphMetaUnreadableError(threadId, err);
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.threadId !== "string") {
    log("error", "graph meta unreadable", { threadId, path: metaPath, message: "no thread id" });
    throw new GraphMetaUnreadableError(threadId, new Error("meta file has no thread id"));
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
    ...(parsed.yamlFormat === "raw" ? { yamlFormat: "raw" as const } : {}),
  };
}

export async function updateGraphMeta(
  dir: string,
  threadId: string,
  patch: Partial<Pick<GraphMeta, "label" | "status" | "graphName">>,
): Promise<GraphMeta | null> {
  assertValidThreadId(threadId);
  return withMetaLock(metaPathFor(dir, threadId), async () => {
    const existing = await readGraphMeta(dir, threadId);
    if (!existing) return null;
    // Thread ids that share a file name ("a/b" and "a_b"): never patch the other thread's record.
    if (existing.threadId !== threadId) throw threadIdTaken(threadId);
    const next: GraphMeta = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await writeGraphMeta(dir, threadId, next);
    return next;
  });
}

/**
 * Load a stored graph. `yaml` is the stored text (raw for current files, so
 * no environment value is ever returned). `${VAR}` placeholders are filled
 * into `spec` only when `expandEnv` is set (trusted authors) and the file was
 * stored raw; files from older servers already hold expanded YAML, and
 * expanding them again would read the environment for text that only looks
 * like a placeholder.
 */
export async function loadPersistedGraph(
  dir: string,
  threadId: string,
  opts: { expandEnv?: boolean } = {},
): Promise<{ yaml: string; spec: GraphSpec; meta: GraphMeta | null } | null> {
  try {
    const stored = await readPersistedGraphYaml(dir, threadId);
    if (!stored) return null;
    const raw = stored.meta?.yamlFormat === "raw";
    const parsed = parseGraphYaml(stored.yaml, { expandEnv: raw && opts.expandEnv === true });
    if (!parsed.spec) return null;
    return { yaml: raw ? stored.yaml : parsed.yaml, spec: parsed.spec, meta: stored.meta };
  } catch (err) {
    if (err instanceof ServerRequestError) throw err;
    return null;
  }
}

/**
 * The stored graph text and meta, without parsing or expanding it, or null
 * when no graph is stored. An unreadable meta file throws
 * {@link GraphMetaUnreadableError}.
 */
export async function readPersistedGraphYaml(dir: string, threadId: string): Promise<{ yaml: string; meta: GraphMeta | null } | null> {
  assertValidThreadId(threadId);
  let yaml: string;
  try {
    yaml = await fs.readFile(graphPathFor(dir, threadId), "utf-8");
  } catch {
    return null;
  }
  return { yaml, meta: await readGraphMeta(dir, threadId) };
}

/**
 * Whether a meta file whose graph file was missing from the listing is a
 * young or old orphan, or not one after all (its graph has appeared since).
 */
async function orphanStatus(dir: string, metaName: string, orphans: { maxAgeMs: number; now: number }): Promise<"young" | "old" | "stored"> {
  const metaPath = path.join(dir, metaName);
  try {
    await fs.lstat(metaPath.slice(0, -".meta.json".length));
    return "stored";
  } catch {
    // No graph file.
  }
  try {
    const st = await fs.lstat(metaPath);
    return orphans.now - st.mtimeMs >= orphans.maxAgeMs ? "old" : "young";
  } catch {
    return "young";
  }
}

/**
 * List persisted run metadata (graph store + `.meta.json` files). Meta files
 * that cannot be read are left out and passed to `onUnreadable` (with the
 * thread id as spelled in the file name), so a caller can tell them from
 * threads without an owner. A file whose name holds no valid thread id (such
 * as `.graph.yaml.meta.json`, an empty id) is skipped and logged: no request
 * can address that thread, and it must not hide the others.
 *
 * With `orphans`, a meta file that has no graph file next to it (a create
 * that stopped after claiming the thread id) is left out while it is younger
 * than `orphans.maxAgeMs`, since another server may still be moving its graph
 * into place, and is listed with status `error` once it is older. Without
 * `orphans` every readable meta file is listed as stored.
 */
export async function listPersistedGraphs(
  dir: string,
  opts: {
    onUnreadable?: (fileThreadId: string, err: GraphMetaUnreadableError) => void;
    orphans?: { maxAgeMs: number; now: number };
  } = {},
): Promise<GraphMeta[]> {
  try {
    await ensureGraphStoreDir(dir);
    const names = await fs.readdir(dir);
    const present = opts.orphans ? new Set(names) : undefined;
    const metas: GraphMeta[] = [];
    for (const name of names) {
      if (!name.endsWith(GRAPH_META_SUFFIX)) continue;
      const threadId = name.slice(0, -GRAPH_META_SUFFIX.length);
      try {
        assertValidThreadId(threadId);
      } catch (err) {
        log("warn", "graph meta file skipped", { path: path.join(dir, name), message: (err as Error).message });
        continue;
      }
      let meta: GraphMeta | null;
      try {
        meta = await readGraphMeta(dir, threadId);
      } catch (err) {
        if (!(err instanceof GraphMetaUnreadableError)) throw err;
        opts.onUnreadable?.(threadId, err);
        continue;
      }
      if (!meta) continue;
      if (opts.orphans && !present!.has(name.slice(0, -".meta.json".length))) {
        const orphan = await orphanStatus(dir, name, opts.orphans);
        if (orphan === "young") continue;
        if (orphan === "old") {
          metas.push({ ...meta, status: "error" });
          continue;
        }
      }
      metas.push(meta);
    }
    metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return metas;
  } catch {
    return [];
  }
}
