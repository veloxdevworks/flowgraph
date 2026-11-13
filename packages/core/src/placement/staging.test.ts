import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { findArtifacts, isArtifactRecord, mapArtifacts, parseStagedPath, stagedPath } from "./artifacts.js";
import { createFakeTransport, type FakeRun, type FakeTransportFixture, type Topology } from "./index.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const WIN = { labels: ["os:windows"], flowgraphVersion: "0.42" };
const topo: Topology = { targets: { w1: { url: "http://w1.test" } } };
const LOCAL_MAC = ["os:macos"];
const spec = (x: unknown) => ({ apiVersion: "flowgraph/v1", kind: "Graph", ...(x as object) }) as unknown as GraphSpec;

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fg-staging-")));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeLocal(rel: string, content: string, withSha = true) {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return { kind: "artifact" as const, path: rel, mimeType: "text/plain", sizeBytes: Buffer.byteLength(content), ...(withSha ? { sha256: sha(content) } : {}) };
}
const workerRecord = (rel: string, content: string) => ({ kind: "artifact", path: rel, mimeType: "text/plain", sizeBytes: Buffer.byteLength(content), sha256: sha(content) });

const child = spec({
  metadata: { name: "child" },
  state: { channels: { doc: { type: "object" }, docs: { type: "array" }, result: { type: "object" }, scratch: { type: "object" } } },
  nodes: [{ id: "noop", type: "wait", with: { duration: "1ms" } }],
  edges: [{ from: "START", to: "noop" }, { from: "noop", to: "END" }],
});
const parent = (out: Record<string, string> = { result: "result" }) =>
  spec({
    metadata: { name: "parent" },
    state: { channels: { doc: { type: "object" }, docs: { type: "array" }, result: { type: "object" }, scratch: { type: "object" } } },
    nodes: [{ id: "place", type: "subgraph", spec: child, runsOn: ["os:windows"], with: { stateMap: { in: { doc: "doc", docs: "docs" }, out } } }],
    edges: [{ from: "START", to: "place" }, { from: "place", to: "END" }],
  });

async function build(fixture: Partial<FakeTransportFixture>, graph = parent()) {
  const transport = createFakeTransport({ w1: { labels: WIN, ...fixture } });
  const compiled = await compileGraph(graph, { cwd: dir, placement: { localLabels: LOCAL_MAC, topology: topo, transport } });
  return { transport, compiled };
}
const completes = (state: Record<string, unknown>): FakeRun => ({ outcome: { status: "completed", state } });
const codeOf = (r: { error?: unknown }) => (r.error as { code?: string } | undefined)?.code;

describe("artifact helpers", () => {
  it("recognises records strictly and finds them in nested data", () => {
    const rec = workerRecord("a.txt", "x");
    expect(isArtifactRecord(rec)).toBe(true);
    expect(isArtifactRecord({ ...rec, sizeBytes: 1.5 })).toBe(false);
    expect(isArtifactRecord({ ...rec, mimeType: "" })).toBe(false);
    expect(isArtifactRecord({ ...rec, sha256: 5 })).toBe(false);
    expect(isArtifactRecord({ path: "a", kind: "file" })).toBe(false);
    expect(findArtifacts({ a: [rec, { b: rec }], c: "x", d: null })).toHaveLength(2);
  });

  it("staged references round-trip and reject traversal", () => {
    const s = sha("x");
    expect(parseStagedPath(stagedPath(s, "a/b/../c d.png"))).toEqual({ sha256: s, basename: "c_d.png" });
    expect(parseStagedPath(`fg-staged:${s}/../x`)).toBeUndefined();
    expect(parseStagedPath(`fg-staged:nothex/x`)).toBeUndefined();
  });

  it("rewrites legacy absolute paths next to a rewritten artifacts list, without mutating the input", async () => {
    const rec = workerRecord(".flowgraph/artifacts/t/shot/s.png", "png");
    const demo = { ok: true, kind: "screenshot", path: "/worker/ws/.flowgraph/artifacts/t/shot/s.png", artifacts: [rec], extra: [{ path: "/worker/ws/.flowgraph/artifacts/t/shot/s.png" }, { path: "/other" }] };
    const out = (await mapArtifacts(demo, async (r) => ({ record: { ...r, path: "new/s.png" }, legacyPath: "/coord/new/s.png" }))) as typeof demo;
    expect(out.path).toBe("/coord/new/s.png");
    expect(out.extra.map((e) => e.path)).toEqual(["/coord/new/s.png", "/other"]);
    expect(out.artifacts[0]!.path).toBe("new/s.png");
    expect(demo.path).toContain("/worker/ws");
    expect(rec.path).toBe(".flowgraph/artifacts/t/shot/s.png");
  });
});

describe("stage-in", () => {
  it("uploads only blobs the worker lacks and sends staged references", async () => {
    const a = await writeLocal("in/a.txt", "alpha");
    const b = await writeLocal("in/b.txt", "bravo", false); // no sha: computed
    const { transport, compiled } = await build({ artifacts: { has: [sha("alpha")] }, attach: completes({ result: { ok: 1 } }) });
    const r = await compiled.run({ threadId: "t-in", input: { doc: a, docs: [b, a] } });
    expect(r.status).toBe("completed");
    expect(transport.hasCalls.map((c) => c.sha256)).toEqual([sha("alpha"), sha("bravo")]);
    expect(transport.putCalls).toHaveLength(1);
    expect(transport.putCalls[0]!.sha256).toBe(sha("bravo"));
    expect(transport.putCalls[0]!.bytes.toString()).toBe("bravo");
    const sent = transport.dispatchCalls[0]!.req.input as { doc: Record<string, unknown>; docs: Array<Record<string, unknown>> };
    expect(sent.doc).toEqual({ ...a, path: `fg-staged:${sha("alpha")}/a.txt`, staged: true });
    expect(sent.docs[0]).toEqual({ ...b, sha256: sha("bravo"), path: `fg-staged:${sha("bravo")}/b.txt`, staged: true });
    // no absolute coordinator path leaves the machine
    expect(JSON.stringify(sent)).not.toContain(dir);
    expect(r.state.result).toEqual({ ok: 1 });
  });

  it("a second dispatch of the same file finds it present and uploads nothing", async () => {
    const a = await writeLocal("in/a.txt", "alpha");
    const { transport, compiled } = await build({ attach: completes({ result: {} }) });
    await compiled.run({ threadId: "t-1", input: { doc: a } });
    await compiled.run({ threadId: "t-2", input: { doc: a } });
    expect(transport.putCalls).toHaveLength(1);
    expect(transport.hasCalls).toHaveLength(2);
  });

  it("a missing file fails with ARTIFACT_MISSING and nothing is sent", async () => {
    const a = await writeLocal("in/a.txt", "alpha");
    const gone = { ...a, path: "in/gone.txt", sha256: sha("gone") };
    const { transport, compiled } = await build({ attach: completes({}) });
    const r = await compiled.run({ threadId: "t-miss", input: { doc: a, docs: [gone] } });
    expect(r.status).toBe("error");
    expect(codeOf(r)).toBe("ARTIFACT_MISSING");
    expect(r.error?.message).toContain("in/gone.txt");
    expect(transport.putCalls).toHaveLength(0);
    expect(transport.dispatchCalls).toHaveLength(0);
  });

  it("refuses a record that points outside the workspace", async () => {
    const outside = path.join(os.tmpdir(), `fg-outside-${process.pid}.txt`);
    await fs.writeFile(outside, "secret");
    try {
      const rec = { kind: "artifact", path: outside, mimeType: "text/plain", sizeBytes: 6 };
      const { transport, compiled } = await build({ attach: completes({}) });
      const r = await compiled.run({ threadId: "t-out", input: { doc: rec } });
      expect(codeOf(r)).toBe("ARTIFACT_MISSING");
      expect(r.error?.message).toContain("outside the workspace");
      expect(transport.putCalls.length + transport.dispatchCalls.length).toBe(0);
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it("an upload failure is ARTIFACT_STAGE_IN_FAILED and nothing is dispatched", async () => {
    const a = await writeLocal("in/a.txt", "alpha");
    const { transport, compiled } = await build({ artifacts: { putError: new Error("disk full") }, attach: completes({}) });
    const r = await compiled.run({ threadId: "t-fail", input: { doc: a } });
    expect(codeOf(r)).toBe("ARTIFACT_STAGE_IN_FAILED");
    expect(r.error?.message).toContain("disk full");
    expect(transport.dispatchCalls).toHaveLength(0);
  });
});

describe("stage-out", () => {
  const OUT = ".flowgraph/artifacts/worker-thread/render/out.txt";

  it("downloads, verifies and rewrites records that flow back", async () => {
    const rec = workerRecord(OUT, "from worker");
    const { transport, compiled } = await build({ artifacts: { blobs: { [sha("from worker")]: "from worker" } }, attach: completes({ result: rec }) });
    const r = await compiled.run({ threadId: "t-out" });
    expect(r.status).toBe("completed");
    expect(transport.getCalls).toHaveLength(1);
    expect(transport.getCalls[0]).toMatchObject({ target: "w1", threadId: "t-out/place/1", sha256: sha("from worker") });
    const rel = ".flowgraph/artifacts/t-out/place/out.txt";
    expect((r.state.result as { path: string }).path).toBe(rel);
    expect(await fs.readFile(path.join(dir, rel), "utf8")).toBe("from worker");
    expect(r.state.result).toEqual({ ...rec, path: rel });
    // no partial files left behind
    expect((await fs.readdir(path.join(dir, path.dirname(rel)))).filter((f) => f.endsWith(".partial"))).toEqual([]);
  });

  it("skips the download when the coordinator already has that content", async () => {
    const rel = ".flowgraph/artifacts/t-have/place/out.txt";
    await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), "from worker");
    const { transport, compiled } = await build({ attach: completes({ result: workerRecord(OUT, "from worker") }) });
    const r = await compiled.run({ threadId: "t-have" });
    expect(r.status).toBe("completed");
    expect(transport.getCalls).toHaveLength(0);
    expect((r.state.result as { path: string }).path).toBe(rel);
  });

  it("keeps different content apart by de-duplicating names", async () => {
    const x = workerRecord("w/out.txt", "one");
    const y = workerRecord("w2/out.txt", "two");
    const { compiled } = await build(
      { artifacts: { blobs: { [sha("one")]: "one", [sha("two")]: "two" } }, attach: completes({ result: { files: [x, y, x] } }) },
    );
    const r = await compiled.run({ threadId: "t-dup" });
    const files = (r.state.result as { files: Array<{ path: string }> }).files.map((f) => f.path);
    expect(files).toEqual([".flowgraph/artifacts/t-dup/place/out.txt", ".flowgraph/artifacts/t-dup/place/out-1.txt", ".flowgraph/artifacts/t-dup/place/out.txt"]);
    expect(await fs.readFile(path.join(dir, files[1]!), "utf8")).toBe("two");
  });

  it("a hash mismatch fails with ARTIFACT_STAGE_OUT_FAILED and leaves no file", async () => {
    const rec = workerRecord(OUT, "expected");
    const { compiled } = await build({ artifacts: { blobs: { [sha("expected")]: "tampered" } }, attach: completes({ result: rec }) });
    const r = await compiled.run({ threadId: "t-bad" });
    expect(r.status).toBe("error");
    expect(codeOf(r)).toBe("ARTIFACT_STAGE_OUT_FAILED");
    expect(r.error?.message).toContain("sha256 mismatch");
    const files = await fs.readdir(path.join(dir, ".flowgraph/artifacts/t-bad/place")).catch(() => []);
    expect(files).toEqual([]);
  });

  it("a failed download is ARTIFACT_STAGE_OUT_FAILED", async () => {
    const rec = workerRecord(OUT, "x");
    const { compiled } = await build({ artifacts: { blobs: { [sha("x")]: new Error("connection reset") } }, attach: completes({ result: rec }) });
    const r = await compiled.run({ threadId: "t-dl" });
    expect(codeOf(r)).toBe("ARTIFACT_STAGE_OUT_FAILED");
    expect(r.error?.message).toContain("connection reset");
  });

  it("a record without sha256 cannot be fetched", async () => {
    const { sha256: _s, ...noSha } = workerRecord(OUT, "x");
    void _s;
    const { compiled } = await build({ attach: completes({ result: noSha }) });
    const r = await compiled.run({ threadId: "t-nosha" });
    expect(codeOf(r)).toBe("ARTIFACT_STAGE_OUT_FAILED");
    expect(r.error?.message).toContain("no valid sha256");
  });

  it("fetches only artifacts that flow back", async () => {
    const wanted = workerRecord("w/wanted.txt", "wanted");
    const stays = workerRecord("w/stays.txt", "stays");
    const { transport, compiled } = await build({
      artifacts: { blobs: { [sha("wanted")]: "wanted", [sha("stays")]: "stays" } },
      attach: completes({ result: wanted, scratch: stays }),
    });
    const r = await compiled.run({ threadId: "t-only" });
    expect(r.status).toBe("completed");
    expect(transport.getCalls.map((c) => c.sha256)).toEqual([sha("wanted")]);
    expect(r.state.scratch).not.toEqual(stays);
  });

  it("a staged-in file that comes back unchanged keeps its coordinator path", async () => {
    const a = await writeLocal("in/a.txt", "alpha");
    const echoed = { ...workerRecord(".flowgraph/artifacts/t-echo_place_1/staged/x/a.txt", "alpha") };
    const { transport, compiled } = await build({ attach: completes({ result: echoed }) });
    const r = await compiled.run({ threadId: "t-echo", input: { doc: a } });
    expect(r.status).toBe("completed");
    expect(transport.getCalls).toHaveLength(0);
    expect((r.state.result as { path: string }).path).toBe("in/a.txt");
  });

  it("rewrites the output of a placed non-subgraph node", async () => {
    const g = spec({
      metadata: { name: "fn-parent" },
      state: { channels: { made: { type: "object" } } },
      nodes: [{ id: "mk", type: "function", runsOn: ["os:windows"], with: { fn: "anything", output: { to: "made" } } }],
      edges: [{ from: "START", to: "mk" }, { from: "mk", to: "END" }],
    });
    const rec = workerRecord("w/made.txt", "made remotely");
    const { transport, compiled } = await build({ artifacts: { blobs: { [sha("made remotely")]: "made remotely" } }, attach: completes({ outputs: { mk: rec } }) }, g);
    const r = await compiled.run({ threadId: "t-fn" });
    expect(r.status).toBe("completed");
    expect(transport.getCalls).toHaveLength(1);
    expect((r.state.made as { path: string }).path).toBe(".flowgraph/artifacts/t-fn/mk/made.txt");
    expect(await fs.readFile(path.join(dir, ".flowgraph/artifacts/t-fn/mk/made.txt"), "utf8")).toBe("made remotely");
  });
});
