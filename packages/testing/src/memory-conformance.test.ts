import {
  AsyncEngineMemoryBackend,
  createInMemoryMemoryBackend,
  createInMemoryGraphNameRegistry,
  type AsyncMemoryTable,
  type MemoryTable,
} from "@flowgraph/core";
import { describeGraphNameRegistryConformance, describeMemoryBackendConformance } from "./memory-conformance.js";

describeGraphNameRegistryConformance("in-memory", async () => ({ registry: createInMemoryGraphNameRegistry() }));

describeMemoryBackendConformance("in-memory", async () => ({ backend: createInMemoryMemoryBackend() }));

/**
 * The async write path (used by network databases) over the in-memory table,
 * with one writer at a time, so both drivers are held to the same cases.
 */
describeMemoryBackendConformance("in-memory (async engine)", async () => {
  const table = (createInMemoryMemoryBackend() as unknown as { table: MemoryTable }).table;
  const view = new Proxy({} as AsyncMemoryTable, {
    get: (_t, method: string) => {
      const f = (table as unknown as Record<string, unknown>)[method];
      if (typeof f !== "function") return undefined;
      return async (...args: unknown[]) => {
        await Promise.resolve();
        return (f as (...a: unknown[]) => unknown).apply(table, args);
      };
    },
  });
  let tail: Promise<unknown> = Promise.resolve();
  const backend = new AsyncEngineMemoryBackend("memory-async", false, view, (fn) => {
    const run = tail.then(() => fn(view));
    tail = run.catch(() => undefined);
    return run;
  });
  return { backend };
});
