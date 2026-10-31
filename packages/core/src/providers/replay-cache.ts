/**
 * Replay scratchpad for agent nodes after LangGraph interrupt().
 *
 * `permission: ask` (and other HITL inside an agent loop) suspends via
 * interrupt(), which replays the whole node on resume. Without a cache the
 * provider re-invokes the model (re-billed, non-deterministic) and re-executes
 * tools that already ran.
 *
 * Entries live in a {@link ReplayStore} that belongs to one execution of a
 * compiled graph (one `run` / `resume` / `continueRun` call). There is no
 * process-wide cache: the store travels with the LangGraph config of that
 * execution (see {@link RUN_SCOPE_KEY}), so nodes of another thread, run or
 * compiled graph can never see it. Across executions, entries survive only
 * as the snapshot the engine attaches to the interrupt that suspended the
 * node; a resume rebuilds its store from the interrupts of its own thread's
 * checkpoint ({@link replayStoreFromInterrupts}). Nothing is read from graph
 * state.
 */

import { AIMessage } from "@langchain/core/messages";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** JSON-safe snapshot of a replay value (revives LangChain AIMessage on load). */
export function serializeReplayValue(value: unknown): unknown {
  if (value instanceof AIMessage) {
    return {
      __fg: "AIMessage",
      content: value.content,
      tool_calls: value.tool_calls ?? [],
      id: value.id,
      name: value.name,
      additional_kwargs: value.additional_kwargs,
    };
  }
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

export function deserializeReplayValue(value: unknown): unknown {
  if (isPlainObject(value) && value["__fg"] === "AIMessage") {
    const rawContent = value["content"];
    const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "");
    return new AIMessage({
      content,
      tool_calls: Array.isArray(value["tool_calls"]) ? (value["tool_calls"] as AIMessage["tool_calls"]) : [],
      additional_kwargs: isPlainObject(value["additional_kwargs"]) ? value["additional_kwargs"] : {},
      ...(typeof value["id"] === "string" ? { id: value["id"] } : {}),
      ...(typeof value["name"] === "string" ? { name: value["name"] } : {}),
    } as ConstructorParameters<typeof AIMessage>[0]);
  }
  return value;
}

export function serializeReplayDump(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entries)) {
    out[k] = serializeReplayValue(v);
  }
  return out;
}

export function deserializeReplayDump(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entries)) {
    out[k] = deserializeReplayValue(v);
  }
  return out;
}


/** Replay entries of one graph execution, keyed by node path (see {@link replayNodeKey}). */
export class ReplayStore {
  private readonly nodes = new Map<string, Map<string, unknown>>();

  get(key: string, index: string): unknown | undefined {
    return this.nodes.get(key)?.get(index);
  }

  set(key: string, index: string, value: unknown): void {
    let entries = this.nodes.get(key);
    if (!entries) {
      entries = new Map();
      this.nodes.set(key, entries);
    }
    entries.set(index, value);
  }

  clear(key: string): void {
    this.nodes.delete(key);
  }

  has(key: string): boolean {
    return this.nodes.has(key);
  }

  /** JSON-safe copy of one node's entries, for an interrupt payload. */
  snapshot(key: string): Record<string, unknown> {
    const entries = this.nodes.get(key);
    if (!entries) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = serializeReplayValue(v);
    return out;
  }

  /**
   * JSON-safe copies of the entries of `key` and of every key below it (a
   * node called as a tool by that node, at any depth), for an interrupt
   * payload. Keys without entries are left out.
   */
  snapshotUnder(key: string): Array<{ node: string; entries: Record<string, unknown> }> {
    const prefix = key.endsWith("]") ? key.slice(0, -1) : key;
    const out: Array<{ node: string; entries: Record<string, unknown> }> = [];
    for (const node of this.nodes.keys()) {
      if (node !== key && !node.startsWith(`${prefix},`)) continue;
      const entries = this.snapshot(node);
      if (Object.keys(entries).length > 0) out.push({ node, entries });
    }
    return out;
  }

  /** Load a snapshot taken by {@link snapshot}; entries already present win. */
  load(key: string, serialized: Record<string, unknown>): void {
    const map = this.nodes.get(key) ?? new Map<string, unknown>();
    for (const [k, v] of Object.entries(deserializeReplayDump(serialized))) {
      if (!map.has(k)) map.set(k, v);
    }
    this.nodes.set(key, map);
  }
}

/**
 * Key of one node's replay entries inside a {@link ReplayStore}: the ids of
 * the subgraph nodes it runs under, then its own id (`["sg", "a"]` for agent
 * `a` inside subgraph node `sg`). A child agent therefore never shares entries
 * with a parent node of the same id.
 */
export function replayNodeKey(path: readonly string[], nodeId: string): string {
  if (!nodeId) throw new Error("replay: a node id is required to build a replay key.");
  return JSON.stringify([...path, nodeId]);
}

/**
 * `config.configurable` key carrying the {@link RunScope} of the current
 * execution. LangGraph keeps `__` keys and non-primitive values out of
 * checkpoint metadata, and graph specs cannot set configurable values.
 */
export const RUN_SCOPE_KEY = "__flowgraphRunScope";

/** Per-execution values nodes read from their LangGraph config. */
export interface RunScope {
  /** Replay entries of this execution. */
  readonly replay: ReplayStore;
  /** Ids of the subgraph nodes between the top graph and the current graph. */
  readonly path: readonly string[];
  /** Run metadata of the top graph; embedded subgraphs report the same run and thread. */
  readonly meta?: { runId: string; threadId?: string | undefined; startedAt: string; graph: string } | undefined;
}

/** The run scope in a LangGraph config, if the node runs inside a compiled graph execution. */
export function runScopeOf(config: unknown): RunScope | undefined {
  const conf = isPlainObject(config) ? config["configurable"] : undefined;
  const scope = isPlainObject(conf) ? conf[RUN_SCOPE_KEY] : undefined;
  return scope && typeof scope === "object" && (scope as RunScope).replay instanceof ReplayStore
    ? (scope as RunScope)
    : undefined;
}

/** A copy of `config` whose run scope sits one subgraph level deeper, under node `nodeId`. */
export function childRunConfig<C extends { configurable?: Record<string, unknown> }>(config: C, nodeId: string): C {
  const scope = runScopeOf(config);
  if (!scope) return config;
  const child: RunScope = { ...scope, path: [...scope.path, nodeId] };
  return { ...config, configurable: { ...(config.configurable ?? {}), [RUN_SCOPE_KEY]: child } };
}

/**
 * A node an agent calls as a tool runs one path level below the agent, under
 * the agent's tool call index (`tool:<n>`): its replay key is
 * `[...agentPath, agentId, "tool:<n>", nodeId]`, so two calls to the same
 * node, in one turn or across turns, never share entries.
 */
const TOOL_SEGMENT = /^tool:[0-9]+$/;

function parseNodeKey(key: unknown): string[] | undefined {
  if (typeof key !== "string") return undefined;
  let path: unknown;
  try {
    path = JSON.parse(key);
  } catch {
    return undefined;
  }
  if (!Array.isArray(path) || path.length === 0 || !path.every((p) => typeof p === "string" && p)) return undefined;
  return path as string[];
}

/** `path` is `owner` followed by one or more `tool:<n>`, node id pairs. */
function isToolCallBelow(path: readonly string[], owner: readonly string[]): boolean {
  if (path.length <= owner.length || (path.length - owner.length) % 2 !== 0) return false;
  for (let i = 0; i < owner.length; i++) if (path[i] !== owner[i]) return false;
  for (let i = owner.length; i < path.length; i += 2) if (!TOOL_SEGMENT.test(path[i]!)) return false;
  return true;
}

export interface ReplayLoadOptions {
  /**
   * The thread being resumed. When set, interrupts saved by releases before
   * per-execution replay stores (`{ key: "<threadId>:<nodeId>", entries }`)
   * are loaded for that top-level node, but only when the key names this
   * thread and the interrupt's own `__nodeId`.
   */
  threadId?: string | undefined;
}

/**
 * Build the replay store for an execution that continues a thread's
 * checkpoint from the snapshot the engine attached to each of its pending
 * interrupts (pass only the interrupts of the snapshot read for that
 * thread). An interrupt restores the entries of the node that raised it
 * (the key must end with its engine-set `__nodeId`) and of nodes it called
 * as tools (keys that extend that key with `tool:<n>`, node id pairs).
 * Anything else in the payload is ignored.
 */
export function replayStoreFromInterrupts(interruptValues: Iterable<unknown>, opts: ReplayLoadOptions = {}): ReplayStore {
  const store = new ReplayStore();
  for (const value of interruptValues) {
    if (!isPlainObject(value)) continue;
    const data = value["data"];
    if (!isPlainObject(data)) continue;
    const blob = data["__agentReplay"];
    const nodeId = data["__nodeId"];
    if (!isPlainObject(blob) || typeof nodeId !== "string" || !nodeId) continue;
    const key = blob["node"];
    const entries = blob["entries"];
    const owner = parseNodeKey(key);
    if (owner && owner[owner.length - 1] === nodeId) {
      if (isPlainObject(entries)) store.load(key as string, entries);
      const nested = blob["nested"];
      if (Array.isArray(nested)) {
        for (const item of nested) {
          if (!isPlainObject(item) || !isPlainObject(item["entries"])) continue;
          const path = parseNodeKey(item["node"]);
          if (path && isToolCallBelow(path, owner)) store.load(item["node"] as string, item["entries"]);
        }
      }
      continue;
    }
    // Saved by an earlier release: read-only, top-level node, this thread only.
    const legacyKey = blob["key"];
    if (opts.threadId && key === undefined && legacyKey === `${opts.threadId}:${nodeId}` && isPlainObject(entries)) {
      store.load(replayNodeKey([], nodeId), entries);
    }
  }
  return store;
}

export function isGraphInterrupt(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const name = (err as { name?: string }).name ?? "";
  return (
    name === "GraphInterrupt" ||
    name === "NodeInterrupt" ||
    "lg_interrupt" in err ||
    "__interrupt" in err
  );
}
