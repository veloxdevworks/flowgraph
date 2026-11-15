import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { renderDeep } from "@flowgraph/expr";
import type { MapWithSchema } from "@flowgraph/spec";
import type { z } from "zod";
import type { NodeRunContext } from "../context.js";
import type { MapTask } from "../nodes/map.js";
import { findArtifacts, sha256OfFile } from "../placement/artifacts.js";

export const MAP_MEMO_CHANNEL = "__mapMemo";
type Options = NonNullable<z.infer<typeof MapWithSchema>["memoize"]>;
type Entry = {
  key: string;
  payload: string;
  bytes: number;
  hash: string;
  generation: number;
  index: number;
};
type Cache = {
  version: 1;
  entries: Entry[];
  maxEntries: number;
  maxBytes: number;
  generation: number;
};
type Caches = Record<string, Cache | null>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const error = (code: string, message: string) =>
  Object.assign(new Error(message), { code, retryable: false });

/** Typed canonical data: undefined and object key order cannot cause collisions. */
function canonical(value: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (depth > 100) throw new Error("memo input too deep");
  if (value === undefined) return ["undefined"];
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return [typeof value, value];
  if (typeof value === "number" && Number.isFinite(value))
    return ["number", Object.is(value, -0) ? "-0" : value];
  if (!value || typeof value !== "object" || seen.has(value))
    throw new Error("non-data memo input");
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error("non-plain memo input");
  seen.add(value);
  try {
    return Array.isArray(value)
      ? ["array", Array.from(value, (x) => canonical(x, seen, depth + 1))]
      : [
          "object",
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical((value as Record<string, unknown>)[k], seen, depth + 1)]),
        ];
  } finally {
    seen.delete(value);
  }
}
function cacheOf(state: Record<string, unknown>, id: string): Cache | undefined {
  const caches = state[MAP_MEMO_CHANNEL] as Caches | undefined;
  const cache = caches && Object.hasOwn(caches, id) ? caches[id] : undefined;
  if (cache == null) return undefined;
  if (
    cache.version !== 1 ||
    !Array.isArray(cache.entries) ||
    !Number.isSafeInteger(cache.generation)
  )
    throw error("MAP_MEMO_INVALID", `map "${id}": invalid memo cache`);
  return cache;
}
export function mapMemoGeneration(state: Record<string, unknown>, id: string): number {
  return (cacheOf(state, id)?.generation ?? 0) + 1;
}
export function clearMapMemo(state: Record<string, unknown>, id: string): Record<string, unknown> {
  return cacheOf(state, id) ? { [MAP_MEMO_CHANNEL]: { [id]: null } } : {};
}
/** Merge parallel successful writes, then deterministically evict the oldest computations. */
export function reduceMapMemo(current: Caches = {}, incoming: Caches = {}): Caches {
  const out = { ...current };
  for (const [id, next] of Object.entries(incoming)) {
    if (next === null) {
      delete out[id];
      continue;
    }
    const previous = Object.hasOwn(out, id) ? out[id] : undefined;
    const entries = new Map((previous?.entries ?? []).map((e) => [e.key, e]));
    for (const entry of next.entries) entries.set(entry.key, entry);
    const sorted = [...entries.values()].sort(
      (a, b) => a.generation - b.generation || a.index - b.index || a.key.localeCompare(b.key),
    );
    let bytes = sorted.reduce((n, e) => n + e.bytes, 0);
    while (sorted.length && (sorted.length > next.maxEntries || bytes > next.maxBytes))
      bytes -= sorted.shift()!.bytes;
    Object.defineProperty(out, id, {
      value: {
        ...next,
        generation: Math.max(previous?.generation ?? 0, next.generation),
        entries: sorted,
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}
async function validateArtifacts(value: unknown, ctx: NodeRunContext): Promise<void> {
  const root = await realpath(ctx.workspace);
  for (const artifact of findArtifacts(value)) {
    try {
      const file = await realpath(path.resolve(root, artifact.path));
      const rel = path.relative(root, file);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
        throw new Error("outside workspace");
      const info = await stat(file);
      if (
        !info.isFile() ||
        info.size !== artifact.sizeBytes ||
        (artifact.sha256 && (await sha256OfFile(file, ctx.signal)) !== artifact.sha256)
      )
        throw new Error("changed artifact");
    } catch {
      throw error(
        "MAP_MEMO_ARTIFACT_INVALID",
        `Cached map artifact is missing, changed or outside the workspace: ${artifact.path}`,
      );
    }
  }
}
export interface MapMemo {
  run(
    identity: unknown,
    invoke: () => Promise<unknown>,
    scope: Record<string, unknown>,
    ctx: NodeRunContext,
  ): Promise<unknown>;
  delta: Record<string, unknown>;
}
export function createMapMemo(
  state: Record<string, unknown>,
  task: MapTask,
  options: Options | undefined,
): MapMemo | undefined {
  if (!options) return undefined;
  const config = options === true ? {} : options;
  const maxEntries = config.maxEntries ?? 128,
    maxBytes = config.maxBytes ?? 16 * 1024 * 1024;
  const cache = cacheOf(state, task.mapId);
  const memo: MapMemo = {
    delta: {},
    async run(identity, invoke, scope, ctx) {
      let key: string;
      try {
        key = hash(
          JSON.stringify(
            canonical({
              item: task.item,
              identity,
              workspace: ctx.workspace,
              config: ctx.config,
              key: config.key === undefined ? undefined : renderDeep(config.key, scope),
              version: config.version,
            }),
          ),
        );
      } catch {
        return invoke();
      } // Non-data input cannot have a safe reusable identity.
      const entry = cache?.entries.find((e) => e.key === key);
      ctx.events.emit(
        "custom.map.memo",
        { mapId: task.mapId, index: task.index, key, hit: !!entry },
        { nodeId: ctx.nodeId, nodeType: "map" },
      );
      if (entry) {
        if (
          typeof entry.payload !== "string" ||
          entry.hash !== hash(entry.payload) ||
          entry.bytes !== Buffer.byteLength(entry.payload)
        )
          throw error("MAP_MEMO_INVALID", `map "${task.mapId}": corrupt memo entry`);
        let value: unknown;
        try {
          value = JSON.parse(entry.payload);
        } catch {
          throw error("MAP_MEMO_INVALID", "Invalid cached map JSON");
        }
        await validateArtifacts(value, ctx);
        return value;
      }
      const rawValue = await invoke();
      const value = ctx.events.redact?.(rawValue) ?? rawValue;
      let payload: string;
      try {
        // JSON round-trip must preserve all types/fields; never coerce undefined, dates or non-finite numbers.
        const original = JSON.stringify(canonical(value));
        payload = JSON.stringify(value);
        if (payload === undefined || JSON.stringify(canonical(JSON.parse(payload))) !== original)
          return value;
      } catch {
        return value;
      }
      const bytes = Buffer.byteLength(payload);
      if (bytes <= maxBytes)
        memo.delta = {
          [MAP_MEMO_CHANNEL]: {
            [task.mapId]: {
              version: 1,
              maxEntries,
              maxBytes,
              generation: task.memoGeneration ?? 1,
              entries: [
                {
                  key,
                  payload,
                  bytes,
                  hash: hash(payload),
                  generation: task.memoGeneration ?? 1,
                  index: task.index,
                },
              ],
            },
          },
        };
      return value;
    },
  };
  return memo;
}
