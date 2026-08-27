/**
 * Replay scratchpad for agent nodes after LangGraph interrupt().
 *
 * `permission: ask` (and other HITL inside an agent loop) suspends via
 * interrupt(), which replays the whole node on resume. Without a cache the
 * provider re-invokes the model (re-billed, non-deterministic) and re-executes
 * tools that already ran.
 *
 * Entries live in-process for the current JS isolate and are also serialized
 * onto interrupt payloads / the `__agentReplay` checkpoint channel so a
 * process restart + `resume` can hydrate them.
 */

import { AIMessage } from "@langchain/core/messages";

export interface AgentReplayCache {
  get(key: string, index: string): unknown | undefined;
  set(key: string, index: string, value: unknown): void;
  clear(key: string): void;
  dump(key: string): Record<string, unknown>;
  load(key: string, entries: Record<string, unknown>): void;
}

export function replayCacheKey(threadId: string, nodeId: string): string {
  return `${threadId}:${nodeId}`;
}

const store = new Map<string, Map<string, unknown>>();

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

export const memoryReplayCache: AgentReplayCache = {
  get(key, index) {
    return store.get(key)?.get(index);
  },
  set(key, index, value) {
    let entries = store.get(key);
    if (!entries) {
      entries = new Map();
      store.set(key, entries);
    }
    entries.set(index, value);
  },
  clear(key) {
    store.delete(key);
  },
  dump(key) {
    const entries = store.get(key);
    if (!entries) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = v;
    return out;
  },
  load(key, entries) {
    const map = store.get(key) ?? new Map<string, unknown>();
    for (const [k, v] of Object.entries(entries)) {
      if (!map.has(k)) map.set(k, v);
    }
    store.set(key, map);
  },
};

/** Test helper: drop every cached replay. */
export function clearAllReplayCaches(): void {
  store.clear();
}

/**
 * Drop all cached entries for a thread (every node key with this prefix).
 * Called on a fresh run start: entries left behind by an interrupted run that
 * was never resumed must not leak into a new run on the same thread.
 */
export function clearThreadReplayCache(threadId: string): void {
  const prefix = `${threadId}:`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Snapshot one node's cache for interrupt payload / checkpoint channel. */
export function snapshotReplay(key: string): Record<string, unknown> {
  return serializeReplayDump(memoryReplayCache.dump(key));
}

/** Hydrate in-process cache from a serialized dump (interrupt / checkpoint). */
export function hydrateReplay(key: string, serialized: Record<string, unknown>): void {
  memoryReplayCache.load(key, deserializeReplayDump(serialized));
}

export function hydrateReplayFromInterruptPayload(payload: unknown): void {
  if (!isPlainObject(payload)) return;
  const data = isPlainObject(payload["data"]) ? payload["data"] : payload;
  const blob = data["__agentReplay"];
  if (!isPlainObject(blob)) return;
  const key = blob["key"];
  const entries = blob["entries"];
  if (typeof key !== "string" || !isPlainObject(entries)) return;
  hydrateReplay(key, entries);
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
