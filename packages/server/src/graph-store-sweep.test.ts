import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listPersistedGraphs, parseGraphYaml, persistGraph, readGraphMeta, type GraphStoreHooks } from "./graph-source.js";
import {
  GRAPH_STORE_SWEEP_MAX_AGE_MS,
  startGraphStoreSweeper,
  sweepGraphStore,
  type GraphStoreSweepResult,
} from "./graph-store-sweep.js";
import { RunService } from "./run-service.js";
import { defaultServerConfig, type ServerConfig, type ThreadOwner } from "./types.js";

/**
 * A failing file system: an `lstat` or `rm` of a file whose name `fault`
 * lists throws the error a real disk would.
 */
const fault = vi.hoisted(() => ({ lstat: new Set<string>(), rm: new Set<string>() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const failing = (op: "lstat" | "rm", file: unknown): void => {
    const name = String(file).split("/").pop()!;
    if (fault[op].has(name)) {
      throw Object.assign(new Error(`EIO: i/o error, ${op} '${String(file)}'`), { code: "EIO", errno: -5, syscall: op, path: String(file) });
    }
  };
  const lstat = (async (file: string, ...rest: unknown[]) => {
    failing("lstat", file);
    return (actual.lstat as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.lstat;
  const rm = (async (file: string, ...rest: unknown[]) => {
    failing("rm", file);
    return (actual.rm as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.rm;
  return { ...actual, lstat, rm, default: { ...actual, lstat, rm } };
});

/** Capture log lines at `level`, parsed. */
function captureLog(method: "log" | "warn"): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, method).mockImplementation((line: unknown) => {
    try {
      lines.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      lines.push({ raw: String(line) });
    }
  });
  return lines;
}

const YAML = `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: sweep }
state:
  channels:
    out: { type: string }
nodes:
  - { id: wait, type: hitl, with: { mode: approve, message: "go?" } }
edges:
  - { from: START, to: wait }
  - { from: wait, to: END }
`;
const spec = parseGraphYaml(YAML, { expandEnv: false }).spec!;
const alice: ThreadOwner = { id: "alice", org: "o" };
const HOUR = 3_600_000;
/** A fixed point in time; files get their mtimes set relative to it. */
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fault.lstat.clear();
  fault.rm.clear();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function storeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-store-sweep-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Write `name` in `dir`, last modified at `mtime` (ms). */
async function fileAt(dir: string, name: string, mtime: number, data = "x"): Promise<void> {
  const file = path.join(dir, name);
  await fs.writeFile(file, data);
  await setMtime(file, mtime);
}
const setMtime = (file: string, mtime: number) => fs.utimes(file, mtime / 1000, mtime / 1000);
const files = async (dir: string) => (await fs.readdir(dir)).sort();

/** A thread whose create stopped after its claim: meta file, no graph file. */
async function orphan(dir: string, threadId: string, mtime: number): Promise<void> {
  const hooks: GraphStoreHooks = {
    beforeGraphMove: () => {
      throw Object.assign(new Error("process died"), { code: "EPERM" });
    },
  };
  await expect(persistGraph(dir, threadId, YAML, spec, { owner: alice, status: "running", hooks })).rejects.toThrow("process died");
  await setMtime(path.join(dir, `${threadId}.graph.yaml.meta.json`), mtime);
}

function service(dir: string, now: () => number, extra: Partial<ServerConfig> = {}, graphStoreHooks?: GraphStoreHooks): RunService {
  const s = new RunService(
    { host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 50, authToken: "t", ...extra },
    { now, ...(graphStoreHooks ? { graphStoreHooks } : {}) },
  );
  cleanup.push(() => s.close());
  return s;
}

describe("sweepGraphStore", () => {
  it("removes temporary files older than the age and reports old graph-less meta files, touching nothing else", async () => {
    const dir = await storeDir();
    await fileAt(dir, ".a.graph.yaml.4242.0123456789ab.tmp", T0);
    await fileAt(dir, ".a.graph.yaml.meta.json.4242.ba9876543210.tmp", T0 - HOUR);
    await fileAt(dir, ".b.graph.yaml.77.00112233aabb.tmp", T0 + 30 * 60_000);
    await fileAt(dir, "notes.tmp", T0);
    await fileAt(dir, ".hidden.tmp", T0);
    await persistGraph(dir, "kept", YAML, spec, { owner: alice });
    await setMtime(path.join(dir, "kept.graph.yaml.meta.json"), T0);
    await orphan(dir, "old", T0);
    await orphan(dir, "young", T0 + 30 * 60_000);

    const result = await sweepGraphStore(dir, { maxAgeMs: HOUR, now: T0 + HOUR });

    expect(result).toEqual({ tempFilesRemoved: 2, orphanedMetas: ["old"], filesFailed: 0 });
    expect(await files(dir)).toEqual([
      ".b.graph.yaml.77.00112233aabb.tmp",
      ".hidden.tmp",
      "kept.graph.yaml",
      "kept.graph.yaml.meta.json",
      "notes.tmp",
      "old.graph.yaml.meta.json",
      "young.graph.yaml.meta.json",
    ]);
    // The claim stays with its owner.
    expect(await readGraphMeta(dir, "old")).toMatchObject({ owner: alice });
    // Sweeping again finds nothing more to remove.
    expect(await sweepGraphStore(dir, { maxAgeMs: HOUR, now: T0 + HOUR })).toEqual({ tempFilesRemoved: 0, orphanedMetas: ["old"], filesFailed: 0 });
  });

  it("uses the configured age", async () => {
    const dir = await storeDir();
    await fileAt(dir, ".a.graph.yaml.1.0123456789ab.tmp", T0);
    expect(await sweepGraphStore(dir, { maxAgeMs: 2 * HOUR, now: T0 + HOUR })).toEqual({ tempFilesRemoved: 0, orphanedMetas: [], filesFailed: 0 });
    expect(await sweepGraphStore(dir, { maxAgeMs: 2 * HOUR, now: T0 + 2 * HOUR })).toEqual({ tempFilesRemoved: 1, orphanedMetas: [], filesFailed: 0 });
  });

  it("leaves a symlink named like a leftover alone, and the old file it points at", async () => {
    const dir = await storeDir();
    const elsewhere = await storeDir();
    const target = path.join(elsewhere, "target.graph.yaml");
    await fileAt(elsewhere, "target.graph.yaml", T0);
    const link = path.join(dir, ".a.graph.yaml.1.0123456789ab.tmp");
    const metaLink = path.join(dir, "linked.graph.yaml.meta.json");
    await fs.symlink(target, link);
    await fs.symlink(target, metaLink);
    // Both the links and what they point at are old.
    for (const l of [link, metaLink]) await fs.lutimes(l, T0 / 1000, T0 / 1000);

    expect(await sweepGraphStore(dir, { maxAgeMs: HOUR, now: T0 + 2 * HOUR })).toEqual({ tempFilesRemoved: 0, orphanedMetas: [], filesFailed: 0 });
    expect(await files(dir)).toEqual([".a.graph.yaml.1.0123456789ab.tmp", "linked.graph.yaml.meta.json"]);
    expect(await files(elsewhere)).toEqual(["target.graph.yaml"]);
  });

  it("leaves a folder named like a leftover alone", async () => {
    const dir = await storeDir();
    for (const name of [".a.graph.yaml.1.0123456789ab.tmp", "folder.graph.yaml.meta.json"]) {
      await fs.mkdir(path.join(dir, name));
      await fileAt(path.join(dir, name), "inside", T0);
      await setMtime(path.join(dir, name), T0);
    }

    expect(await sweepGraphStore(dir, { maxAgeMs: HOUR, now: T0 + 2 * HOUR })).toEqual({ tempFilesRemoved: 0, orphanedMetas: [], filesFailed: 0 });
    expect(await files(dir)).toEqual([".a.graph.yaml.1.0123456789ab.tmp", "folder.graph.yaml.meta.json"]);
    expect(await files(path.join(dir, ".a.graph.yaml.1.0123456789ab.tmp"))).toEqual(["inside"]);
  });

  it("logs a file it cannot check or remove and goes on with the others", async () => {
    const dir = await storeDir();
    for (const name of [".a.graph.yaml.1.0123456789ab.tmp", ".b.graph.yaml.1.0123456789ab.tmp", ".c.graph.yaml.1.0123456789ab.tmp"]) {
      await fileAt(dir, name, T0);
    }
    await orphan(dir, "old", T0);
    fault.lstat.add(".a.graph.yaml.1.0123456789ab.tmp");
    fault.rm.add(".b.graph.yaml.1.0123456789ab.tmp");
    const warnings = captureLog("warn");

    const result = await sweepGraphStore(dir, { maxAgeMs: HOUR, now: T0 + 2 * HOUR });

    expect(result).toEqual({ tempFilesRemoved: 1, orphanedMetas: ["old"], filesFailed: 2 });
    expect(await files(dir)).toEqual([".a.graph.yaml.1.0123456789ab.tmp", ".b.graph.yaml.1.0123456789ab.tmp", "old.graph.yaml.meta.json"]);
    expect(warnings.filter((l) => l["msg"] === "graph-store.sweep file failed").map((l) => [l["file"], l["message"]])).toEqual([
      [path.join(dir, ".a.graph.yaml.1.0123456789ab.tmp"), expect.stringContaining("EIO")],
      [path.join(dir, ".b.graph.yaml.1.0123456789ab.tmp"), expect.stringContaining("EIO")],
    ]);
  });

  it("does nothing for a store directory that does not exist yet", async () => {
    const dir = await storeDir();
    expect(await sweepGraphStore(path.join(dir, "missing"), { maxAgeMs: HOUR, now: T0 })).toEqual({ tempFilesRemoved: 0, orphanedMetas: [], filesFailed: 0 });
  });
});

describe("listing a thread whose graph was never stored", () => {
  it("leaves it out while young, lists it as error once old, and lists it as stored after the owner uploads again", async () => {
    const dir = await storeDir();
    await orphan(dir, "t", T0);
    const list = (now: number) => listPersistedGraphs(dir, { orphans: { maxAgeMs: HOUR, now } });

    expect(await list(T0 + HOUR - 1)).toEqual([]);
    expect(await list(T0 + HOUR)).toEqual([expect.objectContaining({ threadId: "t", status: "error", owner: alice })]);
    // Without `orphans` (owner backfill) the claim is listed as stored.
    expect(await listPersistedGraphs(dir)).toEqual([expect.objectContaining({ threadId: "t", status: "running" })]);

    await persistGraph(dir, "t", YAML, spec, { owner: alice, status: "started" });
    expect(await list(T0 + HOUR)).toEqual([expect.objectContaining({ threadId: "t", status: "started", owner: alice })]);
  });
});

describe("two servers sharing a graph store", () => {
  it("one server's sweep and listing leave another server's create in progress alone, and clear what a crashed one left", async () => {
    const dir = await storeDir();
    let release!: () => void;
    let paused!: () => void;
    const atMove = new Promise<void>((r) => (paused = r));
    const hooks: GraphStoreHooks = {
      beforeGraphMove: () => {
        paused();
        return new Promise<void>((r) => (release = r));
      },
    };
    // Server A starts a thread and stops between claiming it and moving its graph into place.
    const a = service(dir, () => T0, {}, hooks);
    await a.init();
    const started = a.startRun({ threadId: "t", yaml: YAML, input: {} });
    await atMove;
    const staged = (await files(dir)).filter((n) => n.endsWith(".tmp"));
    expect(staged).toHaveLength(1);
    const claimedAt = (await fs.stat(path.join(dir, "t.graph.yaml.meta.json"))).mtimeMs;

    // Server B starts half an hour later: its startup sweep and listing leave A's files alone.
    let bNow = claimedAt + 30 * 60_000;
    const b = service(dir, () => bNow);
    await b.init();
    expect(await files(dir)).toEqual([...staged, "t.graph.yaml.meta.json"]);
    expect(await b.listRuns()).toEqual([]);

    release();
    await started;
    expect(await b.listRuns()).toEqual([expect.objectContaining({ threadId: "t", graphName: "sweep" })]);
    expect((await b.listRuns())[0]!.status).not.toBe("error");

    // Server C crashed mid-create: a staged file and a claim with no graph, both two hours old.
    await fileAt(dir, ".u.graph.yaml.31337.0123456789ab.tmp", T0);
    await orphan(dir, "u", T0);
    bNow = T0 + 2 * HOUR;
    const sweeps: GraphStoreSweepResult[] = [];
    const sweeper = startGraphStoreSweeper(dir, { intervalMs: 0, now: () => bNow, onSweep: (r) => sweeps.push(r) });
    await sweeper.sweepNow();
    await sweeper.stop();
    expect(sweeps).toEqual([{ tempFilesRemoved: 1, orphanedMetas: ["u"], filesFailed: 0 }]);
    // A's run journal (`t.events.jsonl`) is not the sweep's business either.
    expect(await files(dir)).toEqual(["t.events.jsonl", "t.graph.yaml", "t.graph.yaml.meta.json", "u.graph.yaml.meta.json"]);
    const listed = await b.listRuns();
    expect(listed.find((r) => r.threadId === "u")).toMatchObject({ status: "error", active: false });

    // The owner uploads again through B: the thread is stored and no longer failed.
    await b.startRun({ threadId: "u", yaml: YAML, input: {} });
    expect(await files(dir)).toContain("u.graph.yaml");
    expect((await b.listRuns()).find((r) => r.threadId === "u")?.status).not.toBe("error");
  });
});

describe("the sweeper", () => {
  it("sweeps on its interval and stops when stopped", async () => {
    const dir = await storeDir();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const results: GraphStoreSweepResult[] = [];
    let swept!: () => void;
    let next = new Promise<void>((r) => (swept = r));
    const sweeper = startGraphStoreSweeper(dir, {
      intervalMs: 10 * 60_000,
      now: () => T0 + HOUR,
      onSweep: (r) => {
        results.push(r);
        swept();
      },
    });
    await fileAt(dir, ".a.graph.yaml.1.0123456789ab.tmp", T0);

    vi.advanceTimersByTime(10 * 60_000);
    await next;
    expect(results).toEqual([{ tempFilesRemoved: 1, orphanedMetas: [], filesFailed: 0 }]);
    expect(await files(dir)).toEqual([]);

    next = new Promise<void>((r) => (swept = r));
    await sweeper.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(await sweeper.sweepNow()).toEqual({ tempFilesRemoved: 0, orphanedMetas: [], filesFailed: 0 });
    expect(results).toHaveLength(1);
  });

  it("logs each orphaned thread once, not on every sweep", async () => {
    const dir = await storeDir();
    await orphan(dir, "old", T0);
    const sweeper = startGraphStoreSweeper(dir, { intervalMs: 0, now: () => T0 + 2 * HOUR });
    cleanup.push(() => sweeper.stop());
    const lines = captureLog("log");
    const sweepLogs = () => lines.filter((l) => l["msg"] === "graph-store.sweep");

    expect((await sweeper.sweepNow()).orphanedMetas).toEqual(["old"]);
    expect(sweepLogs()).toEqual([expect.objectContaining({ level: "info", orphanedMetas: 1, newOrphanedThreadIds: ["old"] })]);

    expect((await sweeper.sweepNow()).orphanedMetas).toEqual(["old"]);
    expect(sweepLogs()).toHaveLength(1);

    await orphan(dir, "later", T0);
    expect((await sweeper.sweepNow()).orphanedMetas.sort()).toEqual(["later", "old"]);
    expect(sweepLogs()).toHaveLength(2);
    expect(sweepLogs()[1]).toMatchObject({ orphanedMetas: 2, newOrphanedThreadIds: ["later"] });
  });

  it("with interval 0 sweeps only when asked", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const sweeper = startGraphStoreSweeper(await storeDir(), { intervalMs: 0 });
    expect(vi.getTimerCount()).toBe(0);
    await sweeper.stop();
  });

  it("a run service stops its sweeper when it closes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const s = service(await storeDir(), () => T0, { graphStoreSweep: { intervalMs: 10 * 60_000 } });
    await s.init();
    expect(vi.getTimerCount()).toBe(1);
    await s.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a run service sweeps the store at startup", async () => {
    const dir = await storeDir();
    await fileAt(dir, ".a.graph.yaml.1.0123456789ab.tmp", T0);
    await fileAt(dir, ".b.graph.yaml.1.0123456789ab.tmp", T0 + HOUR);
    await service(dir, () => T0 + HOUR).init();
    expect(await files(dir)).toEqual([".b.graph.yaml.1.0123456789ab.tmp"]);
  });
});

describe("sweep settings", () => {
  it("reads the age and interval from the environment", () => {
    const config = defaultServerConfig({ FLOWGRAPH_GRAPH_STORE_SWEEP_AGE_MS: "7200000", FLOWGRAPH_GRAPH_STORE_SWEEP_INTERVAL_MS: "0" });
    expect(config.graphStoreSweep).toEqual({ maxAgeMs: 7_200_000, intervalMs: 0 });
    expect(defaultServerConfig({}).graphStoreSweep).toBeUndefined();
    expect(() => defaultServerConfig({ FLOWGRAPH_GRAPH_STORE_SWEEP_AGE_MS: "1h" })).toThrow("FLOWGRAPH_GRAPH_STORE_SWEEP_AGE_MS must be a whole number");
  });

  it("refuses an age short enough to remove a file still being written, and a bad interval", () => {
    const base = { host: "127.0.0.1", port: 0, graphStoreDir: "/nonexistent", eventBufferSize: 10 };
    expect(() => new RunService({ ...base, graphStoreSweep: { maxAgeMs: 1_000 } })).toThrow("graphStoreSweep.maxAgeMs");
    expect(() => new RunService({ ...base, graphStoreSweep: { intervalMs: 10 } })).toThrow("graphStoreSweep.intervalMs");
    expect(GRAPH_STORE_SWEEP_MAX_AGE_MS).toBe(HOUR);
  });
});
