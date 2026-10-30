import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerFunction } from "@flowgraph/core";
import { RunService } from "./run-service.js";
import type { ServerConfig, ServerMemoryConfig } from "./types.js";

const PG_URL = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];

const graph = (name: string, fn: string, extra = "") => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: ${name} }
state:
  channels:
    out: { type: object }
nodes:
  - { id: n, type: function, with: { fn: ${fn}, output: { to: out } } }
edges:
  - { from: START, to: n }
  - { from: n, to: END }
${extra}`;

let finished = 0;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeAll(() => {
  process.on("unhandledRejection", onUnhandled);
  // Finishes after a short delay, then (when memory is on) touches the database.
  registerFunction("shutdownSlow", async (_input, ctx) => {
    await new Promise((r) => setTimeout(r, 300));
    const value = ctx.memory ? (await ctx.memory.increment("user", "shutdown", "n")).value : { n: 1 };
    finished++;
    return value;
  });
  // Runs until the run is aborted.
  registerFunction("shutdownStuck", async (_input, ctx) => {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 30_000);
      t.unref();
      ctx.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      });
    });
    return { n: 0 };
  });
});
afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  finished = 0;
  unhandled.length = 0;
});

async function service(extra: Partial<ServerConfig> = {}): Promise<RunService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-shutdown-"));
  dirs.push(dir);
  const s = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 100, authToken: "t", ...extra });
  await s.init();
  return s;
}

/** Let any late rejection surface before checking for it. */
const flush = () => new Promise((r) => setTimeout(r, 50));

describe("RunService.close", () => {
  it("refuses new runs, waits for runs in flight, then closes", async () => {
    const s = await service();
    await s.startRun({ threadId: "a", yaml: graph("slow", "shutdownSlow") });
    const closing = s.close();
    await expect(s.startRun({ threadId: "b", yaml: graph("slow2", "shutdownSlow") })).rejects.toMatchObject({ status: 503, code: "SERVER_CLOSING" });
    await expect(s.resumeRun({ threadId: "a", resume: {} })).rejects.toMatchObject({ code: "SERVER_CLOSING" });
    await expect(s.continueRun("a")).rejects.toMatchObject({ code: "SERVER_CLOSING" });
    await expect(s.getState("a")).rejects.toMatchObject({ code: "SERVER_CLOSING" });
    await expect(s.getHistory("a")).rejects.toMatchObject({ code: "SERVER_CLOSING" });
    await closing;
    expect(finished).toBe(1);
    expect(s.registry.get("a")?.status).toBe("completed");
    // Idempotent.
    await expect(s.close()).resolves.toBeUndefined();
    await flush();
    expect(unhandled).toEqual([]);
  });

  it("aborts runs still going at the timeout and does not hang", async () => {
    const s = await service({ shutdownTimeoutMs: 100 });
    await s.startRun({ threadId: "stuck", yaml: graph("stuck", "shutdownStuck") });
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await s.close();
    expect(Date.now() - t0).toBeLessThan(2_500);
    expect(["error", "cancelled"]).toContain(s.registry.get("stuck")?.status);
    await flush();
    expect(unhandled).toEqual([]);
  });

  it("does not wait forever for a pool that never closes, and still closes the rest", async () => {
    const s = await service({ closeTimeoutMs: 100 });
    let closed = 0;
    const closers = (s as unknown as { closers: Array<() => Promise<void>> }).closers;
    closers.push(async () => {
      closed++;
    });
    closers.push(() => new Promise<void>(() => {}));
    closers.push(async () => {
      throw new Error("close failed");
    });
    const t0 = Date.now();
    await s.close();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(closed).toBe(1);
  });

  it("does not leave a running placeholder when the graph fails to compile", async () => {
    const s = await service();
    // Durable memory is not configured, so compiling a graph that needs it fails.
    const bad = graph("bad", "shutdownSlow", "runtime:\n  checkpoint: { enabled: true, backend: sqlite }\n  memory: {}\n");
    await expect(s.startRun({ threadId: "bad", yaml: bad })).rejects.toThrow(/MEMORY_BACKEND_UNAVAILABLE/);
    expect(s.registry.get("bad")).toBeUndefined();
    await s.close();
  });

  it.skipIf(!PG_URL)("with postgres, closes pools only after runs in flight finish, with no unhandled rejection", async () => {
    const memory: ServerMemoryConfig = { backend: "postgres", identity: { org: `shutdown-${randomUUID()}`, project: "local", user: "ops" } };
    const s = await service({ databaseUrl: PG_URL!, memory });
    const yaml = graph(`pg-slow-${randomUUID()}`, "shutdownSlow", "runtime:\n  checkpoint: { enabled: true, backend: postgres }\n  memory: {}\n");
    const threads = [`pg-${randomUUID()}`, `pg-${randomUUID()}`];
    for (const threadId of threads) await s.startRun({ threadId, yaml });
    await s.close();
    for (const t of threads) expect(s.registry.get(t)?.status, JSON.stringify(s.registry.get(t)?.events.filter((e) => e.type.endsWith("error")))).toBe("completed");
    expect(finished).toBe(2);
    await flush();
    expect(unhandled).toEqual([]);
  });
});
