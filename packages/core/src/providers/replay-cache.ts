/**
 * In-process scratchpad for agent node replay after LangGraph interrupt().
 *
 * `permission: ask` (and other HITL inside an agent loop) suspends via
 * interrupt(), which replays the whole node on resume. Without a cache the
 * provider re-invokes the model (re-billed, non-deterministic) and re-executes
 * tools that already ran. Entries are keyed by threadId:nodeId and a sequence
 * index; a sidecar restart simply degrades to uncached replay.
 */

export interface AgentReplayCache {
  get(key: string, index: string): unknown | undefined;
  set(key: string, index: string, value: unknown): void;
  clear(key: string): void;
}

export function replayCacheKey(threadId: string, nodeId: string): string {
  return `${threadId}:${nodeId}`;
}

const store = new Map<string, Map<string, unknown>>();

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
