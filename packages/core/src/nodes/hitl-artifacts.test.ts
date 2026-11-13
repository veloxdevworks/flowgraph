import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Artifact, GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";
import { resolveGateArtifacts } from "./hitl-artifacts.js";
import { hitlSelectDiagnostics } from "../runtime/validate-graph.js";
import type { JobHandle, MediaCallContext, MediaProvider, MediaRequest } from "../media/types.js";

function pngBytes(tag: string): Uint8Array {
  // Not a decodable image; the engine never decodes it. Distinct bytes per call.
  return Uint8Array.from(Buffer.from(`\x89PNG-fake-${tag}`, "latin1"));
}

function fakeImages(starts: MediaRequest[]): MediaProvider {
  return {
    name: "fake",
    vendor: "fake",
    modalities: ["image"],
    maxPerJob: { image: 10 },
    async start(req: MediaRequest, ctx: MediaCallContext): Promise<JobHandle> {
      starts.push(req);
      const done: Artifact[] = [];
      for (let i = 0; i < req.count; i++) {
        done.push(await ctx.saveOutput({ bytes: pngBytes(`${starts.length}-${i}`), mimeType: "image/png" }));
      }
      return { id: `job-${starts.length}`, done };
    },
    estimateCostUSD: () => 0,
  };
}

function graph(nodes: Array<Record<string, unknown>>, edges: Array<Record<string, unknown>>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "gate-artifacts" },
    state: { channels: { check: { type: "object" } } },
    nodes,
    edges,
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}

const img = (extra: Record<string, unknown> = {}) => ({
  id: "img",
  type: "image",
  provider: "fake",
  with: { prompt: "a lighthouse", count: 2, ...extra },
});

/** image -> gate -> END */
function gateGraph(gateWith: Record<string, unknown>, gateType = "hitl"): GraphSpec {
  return graph(
    [img(), { id: "gate", type: gateType, with: { message: "Look", ...gateWith } }],
    [
      { from: "START", to: "img" },
      { from: "img", to: "gate" },
      { from: "gate", to: "END" },
    ],
  );
}

type Data = {
  artifacts: Artifact[];
  artifactRefs: string[];
  select?: string;
  validationError?: string;
  mode: string;
};
const dataOf = (res: { interrupts?: Array<{ payload?: unknown }> | undefined }): Data =>
  (res.interrupts![0]!.payload as { data: Data }).data;
const outputsOf = (res: { state: Record<string, unknown> }) =>
  res.state["outputs"] as Record<string, Record<string, unknown> & { artifacts: Artifact[]; artifact: Artifact }>;

let dir: string;
let outside: string;
let starts: MediaRequest[];
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "fg-gate-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "fg-gate-outside-"));
  starts = [];
  await mkdir(path.join(dir, "notes"), { recursive: true });
  await writeFile(path.join(dir, "notes", "a.txt"), "hello");
  await writeFile(path.join(dir, "notes", "other.png"), "not presented");
  await writeFile(path.join(outside, "secret.png"), "secret");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const compile = (spec: GraphSpec, checkpointer?: MemorySaver) =>
  compileGraph(spec, { cwd: dir, mediaProviders: [fakeImages(starts)], ...(checkpointer ? { checkpointer } : {}) });

describe("hitl with.artifacts: template shapes", () => {
  it("flattens records, arrays, whole media outputs and paths; de-dupes by path; never [object Object]", async () => {
    await symlink(path.join(outside, "secret.png"), path.join(dir, "notes", "link.png"));
    const g = await compile(
      gateGraph({
        mode: "review",
        artifacts: [
          "{{ state.outputs.img.artifact }}",
          "{{ state.outputs.img.artifacts }}",
          "{{ state.outputs.img }}",
          "{{ state.outputs.img.artifact.path }}",
          "notes/a.txt",
          "./notes/a.txt",
          "demo://manifest/ref-1",
          "notes/missing.png",
          path.join(outside, "secret.png"),
          "notes/link.png",
          "../escape.png",
        ],
      }),
    );
    const res = await g.run({ threadId: "shapes", onInterrupt: "fail" });
    expect(res.status).toBe("interrupted");
    const data = dataOf(res);

    // 2 generated images + the text file; everything else cannot be a record.
    expect(data.artifacts).toHaveLength(3);
    expect(data.artifacts.map((a) => a.role)).toEqual(["image", "image", "file"]);
    expect(data.artifacts[2]).toMatchObject({ kind: "artifact", path: "notes/a.txt", mimeType: "application/octet-stream", sizeBytes: 5 });
    expect(data.artifacts[0]!.path).toMatch(/^\.flowgraph\/artifacts\//);
    // Order and de-duplication: records first (their paths), then the strings that stayed refs.
    expect(data.artifactRefs).toEqual([
      data.artifacts[0]!.path,
      data.artifacts[1]!.path,
      "notes/a.txt",
      "demo://manifest/ref-1",
      "notes/missing.png",
      path.join(outside, "secret.png"),
      "notes/link.png",
      "../escape.png",
    ]);
    expect(JSON.stringify(data)).not.toContain("[object Object]");
    // The record from the producer (with sha256) wins over a stat-derived one.
    expect(data.artifacts[0]!.sha256).toBeTypeOf("string");
    expect(data.select).toBeUndefined();
  });

  it("maps a bare path string to a record using the mime/role helpers", async () => {
    await writeFile(path.join(dir, "notes", "m.glb"), "glTF");
    const g = await compile(gateGraph({ mode: "approve", artifacts: ["notes/m.glb"] }));
    const data = dataOf(await g.run({ threadId: "mime", onInterrupt: "fail" }));
    expect(data.artifacts[0]).toMatchObject({ path: "notes/m.glb", mimeType: "model/gltf-binary", role: "model3d", sizeBytes: 4 });
  });

  it("presents artifacts in approve and choice modes, not only review", async () => {
    const approve = await (await compile(gateGraph({ mode: "approve", artifacts: ["{{ state.outputs.img.artifacts }}"] }))).run({
      threadId: "ap",
      onInterrupt: "fail",
    });
    expect(dataOf(approve).artifacts).toHaveLength(2);
    expect(dataOf(approve).artifactRefs).toHaveLength(2);

    const choice = await (
      await compile(gateGraph({ mode: "choice", choices: ["keep", "drop"], artifacts: ["{{ state.outputs.img.artifacts }}"] }))
    ).run({ threadId: "ch", onInterrupt: "fail" });
    expect(dataOf(choice).artifacts).toHaveLength(2);
    expect(dataOf(choice).mode).toBe("choice");
  });

  it("does not leak file bytes into the payload", async () => {
    const g = await compile(gateGraph({ mode: "review", artifacts: ["{{ state.outputs.img }}"] }));
    const res = await g.run({ threadId: "bytes", onInterrupt: "fail" });
    expect(JSON.stringify(dataOf(res))).not.toContain("fake-1-0");
  });

  it("workshop artifactRefs are paths, not [object Object]", async () => {
    const g = await compile(
      gateGraph(
        { message: "W", agenda: ["x"], artifacts: ["{{ state.outputs.img }}", "demo://x"] },
        "workshop",
      ),
    );
    const res = await g.run({ threadId: "ws", onInterrupt: "fail" });
    const refs = (res.interrupts![0]!.payload as { data: { artifactRefs: string[] } }).data.artifactRefs;
    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatch(/^\.flowgraph\/artifacts\//);
    expect(refs[2]).toBe("demo://x");
    expect(refs.join()).not.toContain("[object Object]");
  });
});

describe("hitl with.artifacts: demo outputs", () => {
  /** A state channel holding a `demo` output -> gate -> END. */
  const demoGate = (message = "Look") =>
    ({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "demo-gate" },
      state: { channels: { capture: { type: "object" } } },
      nodes: [{ id: "gate", type: "hitl", with: { mode: "approve", message, artifacts: ["{{ state.capture }}"] } }],
      edges: [
        { from: "START", to: "gate" },
        { from: "gate", to: "END" },
      ],
    }) as unknown as GraphSpec;

  const run = async (capture: Record<string, unknown>) => {
    const res = await (await compile(demoGate())).run({ threadId: "demo", onInterrupt: "fail", input: { capture } });
    const payload = res.interrupts![0]!.payload as { reason?: string; message?: string; data: Data & { captureFailures?: unknown[] } };
    return { data: payload.data, message: payload.reason ?? payload.message ?? "" };
  };

  it("presents a capture's extra recording alongside its file", async () => {
    await writeFile(path.join(dir, "shot.png"), "png");
    await writeFile(path.join(dir, "shot.webm"), "webm");
    const out = await resolveGateArtifacts(
      [
        {
          ok: true,
          kind: "screenshot",
          path: path.join(dir, "shot.png"),
          extra: [{ path: path.join(dir, "shot.webm"), mimeType: "video/webm", kind: "video" }],
        },
      ],
      dir,
    );
    expect(out.artifacts.map((a) => a.path)).toEqual(["shot.png", "shot.webm"]);
    expect(out.captureFailures).toEqual([]);
  });

  it("reports a failed capture with no file instead of dropping it", async () => {
    const out = await resolveGateArtifacts(
      [{ ok: false, kind: "screenshot", label: "home", reason: "browser is not installed" }],
      dir,
    );
    expect(out.artifacts).toEqual([]);
    expect(out.captureFailures).toEqual([{ kind: "screenshot", label: "home", reason: "browser is not installed" }]);
  });

  it("shows a failed capture's file and says that it failed", async () => {
    await writeFile(path.join(dir, "t.json"), "{}");
    const out = await resolveGateArtifacts(
      [{ ok: false, kind: "http", path: path.join(dir, "t.json"), reason: "returned HTTP 500" }],
      dir,
    );
    expect(out.artifacts.map((a) => a.path)).toEqual(["t.json"]);
    expect(out.captureFailures[0]).toMatchObject({ reason: "returned HTTP 500" });
  });

  it("reads a failure before it follows artifacts, so the new field cannot hide it", async () => {
    await writeFile(path.join(dir, "t.json"), "{}");
    const record: Artifact = { kind: "artifact", path: "t.json", mimeType: "application/json", sizeBytes: 2, role: "file" };
    const out = await resolveGateArtifacts(
      [
        { ok: false, status: "failed", kind: "http", path: path.join(dir, "t.json"), reason: "returned HTTP 500", artifacts: [record] },
        { ok: false, status: "not_captured", kind: "screenshot", label: "home", path: null, reason: "refused", artifacts: [] },
        { ok: true, status: "inconclusive", kind: "file", path: null, reason: null, artifacts: [] },
      ],
      dir,
    );
    expect(out.captureFailures).toEqual([
      { kind: "http", reason: "returned HTTP 500", path: path.join(dir, "t.json") },
      { kind: "screenshot", label: "home", reason: "refused" },
    ]);
    // The failed capture's evidence is still shown, from its records and only once.
    expect(out.artifacts.map((a) => a.path)).toEqual(["t.json"]);
  });

  describe("when the demo ran in another workspace", () => {
    const rel = ".flowgraph/artifacts/t/prove";
    /** A demo output whose files live under `root`, as `demo` writes it. */
    async function demoOutput(root: string, over: Record<string, unknown> = {}) {
      await mkdir(path.join(root, rel), { recursive: true });
      await writeFile(path.join(root, rel, "shot.png"), "png");
      await writeFile(path.join(root, rel, "shot.webm"), "webm");
      const record = (name: string, mimeType: string, role: Artifact["role"], sha256: string): Artifact => ({
        kind: "artifact", path: `${rel}/${name}`, mimeType, sizeBytes: 3, role, sha256,
      });
      return {
        ok: true,
        status: "inconclusive",
        kind: "screenshot",
        path: path.join(root, rel, "shot.png"),
        extra: [{ path: path.join(root, rel, "shot.webm"), mimeType: "video/webm", kind: "video" }],
        reason: null,
        artifacts: [record("shot.png", "image/png", "image", "hash-png"), record("shot.webm", "video/webm", "video", "hash-webm")],
        ...over,
      };
    }

    it("keeps the producer's full records when the gate shares the workspace", async () => {
      const out = await resolveGateArtifacts([await demoOutput(dir)], dir);
      expect(out.artifacts.map((a) => [a.path, a.sha256])).toEqual([
        [`${rel}/shot.png`, "hash-png"],
        [`${rel}/shot.webm`, "hash-webm"],
      ]);
      expect(out.artifactRefs).toEqual([`${rel}/shot.png`, `${rel}/shot.webm`]);
    });

    it("gives the main file and each extra as a plain absolute ref, never a record that points nowhere", async () => {
      const demo = await demoOutput(outside);
      const out = await resolveGateArtifacts([demo], dir);
      expect(out.artifacts).toEqual([]);
      expect(out.artifactRefs).toEqual([demo.path, (demo.extra as Array<{ path: string }>)[0]!.path]);
      expect(out.captureFailures).toEqual([]);
    });

    it("still lists a failure from another workspace, with its files as refs", async () => {
      const demo = await demoOutput(outside, { ok: false, status: "failed", reason: "page returned HTTP 500" });
      const out = await resolveGateArtifacts([demo], dir);
      expect(out.artifacts).toEqual([]);
      expect(out.artifactRefs).toHaveLength(2);
      expect(out.captureFailures).toEqual([{ kind: "screenshot", reason: "page returned HTTP 500", path: demo.path }]);

      const none = await resolveGateArtifacts(
        [{ ok: false, status: "not_captured", kind: "screenshot", path: null, extra: null, reason: "refused", artifacts: [] }],
        dir,
      );
      expect(none.captureFailures).toEqual([{ kind: "screenshot", reason: "refused" }]);
    });

    it("does not present a same-named file in the gate's workspace as the demo's", async () => {
      const demo = await demoOutput(outside);
      await demoOutput(dir); // a different file at the same relative paths, here
      const out = await resolveGateArtifacts([demo], dir);
      expect(out.artifacts).toEqual([]);
      expect(out.artifactRefs).toEqual([demo.path, (demo.extra as Array<{ path: string }>)[0]!.path]);
    });

    it("treats each file on its own: the main file here, an extra elsewhere", async () => {
      const demo = await demoOutput(dir);
      await mkdir(path.join(outside, rel), { recursive: true });
      await writeFile(path.join(outside, rel, "shot.webm"), "webm");
      (demo.extra as Array<{ path: string }>)[0]!.path = path.join(outside, rel, "shot.webm");
      const out = await resolveGateArtifacts([demo], dir);
      expect(out.artifacts.map((a) => a.path)).toEqual([`${rel}/shot.png`]);
      expect(out.artifactRefs).toEqual([`${rel}/shot.png`, path.join(outside, rel, "shot.webm")]);
    });

    it("presents nothing for a file that was deleted", async () => {
      const demo = await demoOutput(dir);
      await rm(demo.path as string);
      const out = await resolveGateArtifacts([demo], dir);
      expect(out.artifacts.map((a) => a.path)).toEqual([`${rel}/shot.webm`]);
      expect(out.artifactRefs).toContain(demo.path);
    });
  });

  it("shows a real demo failure at the gate, with the evidence it kept", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      const spec = {
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: "demo-then-gate" },
        state: { channels: {} },
        nodes: [
          { id: "prove", type: "demo", with: { http: { url } } },
          {
            id: "gate",
            type: "hitl",
            with: { mode: "approve", message: "Ship?", artifacts: ["{{ state.outputs.prove }}"] },
          },
        ],
        edges: [
          { from: "START", to: "prove" },
          { from: "prove", to: "gate" },
          { from: "gate", to: "END" },
        ],
        runtime: { checkpoint: { enabled: true, backend: "memory" } },
      } as unknown as GraphSpec;
      const res = await (await compile(spec)).run({ threadId: "real-demo", onInterrupt: "fail" });
      const payload = res.interrupts![0]!.payload as { reason?: string; message?: string; data: Data & { captureFailures: unknown[] } };

      expect(payload.reason ?? payload.message).toContain("Capture problems (1):");
      expect(payload.reason ?? payload.message).toContain("returned HTTP 500");
      expect(payload.data.captureFailures).toHaveLength(1);
      expect(payload.data.artifacts).toHaveLength(1);
      expect(payload.data.artifacts[0]!.path).toMatch(/^\.flowgraph\/artifacts\/real-demo\/prove\/.+\.json$/);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("puts the failure in the message every client shows", async () => {
    const { data, message } = await run({ ok: false, kind: "video", label: "checkout", reason: "page returned HTTP 502" });
    expect(message).toContain("Look");
    expect(message).toContain("Capture problems (1):");
    expect(message).toContain("- checkout: page returned HTTP 502");
    expect(data.captureFailures).toHaveLength(1);
  });

  it("leaves the message and payload alone when every capture worked", async () => {
    await writeFile(path.join(dir, "ok.png"), "png");
    const { data, message } = await run({ ok: true, kind: "screenshot", path: path.join(dir, "ok.png") });
    expect(message).toBe("Look");
    expect(data).not.toHaveProperty("captureFailures");
    expect(data.artifacts).toHaveLength(1);
  });
});

describe("hitl with.select", () => {
  const imgs = "{{ state.outputs.img.artifacts }}";

  it("accepts a presented path, { path }, and returns the full record", async () => {
    for (const [i, pick] of [
      (a: Artifact[]) => a[1]!.path,
      (a: Artifact[]) => ({ path: a[1]!.path }),
      (a: Artifact[]) => [{ path: `./${a[1]!.path}` }],
    ].entries()) {
      const g = await compile(
        gateGraph({ mode: "review", select: "one", decision: ["approve", "request-changes"], artifacts: [imgs] }),
      );
      const t = `sel-${i}`;
      const first = await g.run({ threadId: t, onInterrupt: "fail" });
      expect(dataOf(first).select).toBe("one");
      const art = dataOf(first).artifacts;
      const done = await g.resume({ threadId: t, resume: { decision: "approve", selected: pick(art) }, onInterrupt: "fail" });
      expect(done.status).toBe("completed");
      const gate = outputsOf(done)["gate"]!;
      expect(gate["selected"]).toEqual(art[1]);
      expect(gate["decision"]).toBe("approve");
    }
  });

  it("re-prompts on a path that was not presented, however it is spelled", async () => {
    const g = await compile(gateGraph({ mode: "review", select: "one", artifacts: [imgs], maxResumeAttempts: 20 }));
    const first = await g.run({ threadId: "inj", onInterrupt: "fail" });
    const good = dataOf(first).artifacts[0]!;
    for (const [n, bad] of ["notes/other.png", "../escape.png", path.join(outside, "secret.png"), { path: "notes/a.txt" }, 42, { nope: 1 }].entries()) {
      const r = await g.resume({ threadId: "inj", resume: { decision: "approve", selected: bad }, onInterrupt: "fail" });
      expect(r.status).toBe("interrupted");
      expect(r.interrupts![0]).toMatchObject({ attempt: n + 1 });
      expect(dataOf(r).validationError).toMatch(/selected|entries/);
    }
    const ok = await g.resume({ threadId: "inj", resume: { decision: "approve", selected: good.path }, onInterrupt: "fail" });
    expect(ok.status).toBe("completed");
    expect(outputsOf(ok)["gate"]!["selected"]).toEqual(good);
  });

  it("rejects an unpresented selection in approve and choice modes too", async () => {
    const a = await compile(gateGraph({ mode: "approve", select: "one", artifacts: [imgs] }));
    await a.run({ threadId: "ia", onInterrupt: "fail" });
    const r = await a.resume({ threadId: "ia", resume: { approved: true, selected: "notes/other.png" }, onInterrupt: "fail" });
    expect(r.status).toBe("interrupted");
    expect(dataOf(r).validationError).toMatch(/not presented/);

    const c = await compile(gateGraph({ mode: "choice", choices: ["x", "y"], select: "one", artifacts: [imgs] }));
    await c.run({ threadId: "ic", onInterrupt: "fail" });
    const r2 = await c.resume({ threadId: "ic", resume: { choice: "x", selected: "notes/other.png" }, onInterrupt: "fail" });
    expect(r2.status).toBe("interrupted");
    expect(dataOf(r2).validationError).toMatch(/not presented/);
  });

  it("requires a selection on approval and on any choice answer, but not on a rejection", async () => {
    const a = await compile(gateGraph({ mode: "approve", select: "one", artifacts: [imgs] }));
    await a.run({ threadId: "ra", onInterrupt: "fail" });
    const need = await a.resume({ threadId: "ra", resume: { approved: true }, onInterrupt: "fail" });
    expect(need.status).toBe("interrupted");
    expect(dataOf(need).validationError).toMatch(/selection is required/);
    const rej = await a.resume({ threadId: "ra", resume: { approved: false }, onInterrupt: "fail" });
    expect(rej.status).toBe("completed");
    expect(outputsOf(rej)["gate"]).toMatchObject({ approved: false, selected: null });

    const c = await compile(gateGraph({ mode: "choice", choices: ["x", "y"], select: "many", artifacts: [imgs] }));
    await c.run({ threadId: "rc", onInterrupt: "fail" });
    const needc = await c.resume({ threadId: "rc", resume: { choice: "y" }, onInterrupt: "fail" });
    expect(needc.status).toBe("interrupted");
    const all = dataOf(needc).artifacts;
    const okc = await c.resume({ threadId: "rc", resume: { choice: "y", selected: all.map((x) => x.path) }, onInterrupt: "fail" });
    expect(okc.status).toBe("completed");
    expect(outputsOf(okc)["gate"]!["selected"]).toEqual(all);
    expect(outputsOf(okc)["gate"]!["choice"]).toBe("y");
  });

  it("select: one rejects several; select: many accepts a subset and a single string", async () => {
    const one = await compile(gateGraph({ mode: "review", select: "one", artifacts: [imgs] }));
    const f = await one.run({ threadId: "multi", onInterrupt: "fail" });
    const art = dataOf(f).artifacts;
    const r = await one.resume({ threadId: "multi", resume: { decision: "approve", selected: art.map((x) => x.path) }, onInterrupt: "fail" });
    expect(r.status).toBe("interrupted");
    expect(dataOf(r).validationError).toMatch(/exactly one/);

    const many = await compile(gateGraph({ mode: "review", select: "many", artifacts: [imgs] }));
    const mf = await many.run({ threadId: "many", onInterrupt: "fail" });
    const mart = dataOf(mf).artifacts;
    const m = await many.resume({ threadId: "many", resume: { decision: "approve", selected: mart[0]!.path }, onInterrupt: "fail" });
    expect(m.status).toBe("completed");
    expect(outputsOf(m)["gate"]!["selected"]).toEqual([mart[0]]);
  });

  it("auto-selects the only presented artifact on an approving outcome", async () => {
    const g = await compile(gateGraph({ mode: "approve", select: "one", artifacts: ["notes/a.txt"] }));
    await g.run({ threadId: "auto", onInterrupt: "fail" });
    const done = await g.resume({ threadId: "auto", resume: true, onInterrupt: "fail" });
    expect(done.status).toBe("completed");
    expect(outputsOf(done)["gate"]).toMatchObject({ approved: true, selected: { path: "notes/a.txt" } });
  });

  it("select: none strips a client-sent selected in every mode", async () => {
    const forged = { kind: "artifact", path: "/etc/passwd", mimeType: "text/plain", sizeBytes: 1 };
    for (const [mode, extra, answer] of [
      ["review", {}, { decision: "approve" }],
      ["approve", {}, { approved: true }],
      ["choice", { choices: ["x"] }, { choice: "x" }],
    ] as const) {
      const g = await compile(gateGraph({ mode, artifacts: [imgs], ...extra }));
      const t = `none-${mode}`;
      await g.run({ threadId: t, onInterrupt: "fail" });
      const done = await g.resume({ threadId: t, resume: { ...answer, selected: forged }, onInterrupt: "fail" });
      expect(done.status).toBe("completed");
      expect(outputsOf(done)["gate"]).not.toHaveProperty("selected");
    }
  });

  it("validated records beat a client-supplied selected object in review mode", async () => {
    const g = await compile(gateGraph({ mode: "review", select: "one", artifacts: [imgs] }));
    const f = await g.run({ threadId: "win", onInterrupt: "fail" });
    const real = dataOf(f).artifacts[0]!;
    const done = await g.resume({
      threadId: "win",
      resume: { decision: "approve", selected: { path: real.path, mimeType: "evil/x", sizeBytes: 999999 } },
      onInterrupt: "fail",
    });
    expect(outputsOf(done)["gate"]!["selected"]).toEqual(real);
  });
});

describe("hitl round", () => {
  /** img -> check (review) ; request-changes loops back to img ; approve ends. */
  function loop(extraImg: Record<string, unknown> = {}): GraphSpec {
    return graph(
      [
        img(extraImg),
        {
          id: "review",
          type: "hitl",
          with: {
            mode: "review",
            message: "Pick",
            decision: ["approve", "request-changes"],
            artifacts: ["{{ state.outputs.img.artifacts }}"],
            select: "one",
            routes: { approve: "END", "request-changes": "img" },
            output: { to: "check" },
          },
        },
      ],
      [
        { from: "START", to: "img" },
        { from: "img", to: "review" },
      ],
    );
  }

  it("counts accepted answers across a loop and a real resume; re-prompts do not count", async () => {
    const saver = new MemorySaver();
    const t = "round";
    let g = await compile(loop(), saver);
    expect((await g.run({ threadId: t, onInterrupt: "fail" })).status).toBe("interrupted");

    // Round 1: an invalid answer re-prompts, then a valid rejection loops back.
    const bad = await g.resume({ threadId: t, resume: { decision: "bogus" }, onInterrupt: "fail" });
    expect(bad.status).toBe("interrupted");
    // A fresh engine on the same checkpoint store: the node re-executes from the top on resume.
    g = await compile(loop(), saver);
    const again = await g.resume({ threadId: t, resume: { decision: "request-changes" }, onInterrupt: "fail" });
    expect(again.status).toBe("interrupted"); // looped back through img, now waiting at the gate again
    const snap = await g.getState(t);
    const afterRound1 = (snap!.values["check"] as { round: number }).round;
    expect(afterRound1).toBe(1);

    // Round 2, resumed on yet another engine.
    g = await compile(loop(), saver);
    const r2 = await g.resume({ threadId: t, resume: { decision: "request-changes" }, onInterrupt: "fail" });
    expect(r2.status).toBe("interrupted");
    expect((await g.getState(t))!.values["check"]).toMatchObject({ round: 2 });

    // Round 3 approves with a selection.
    g = await compile(loop(), saver);
    const art = dataOf(r2).artifacts;
    const done = await g.resume({ threadId: t, resume: { decision: "approve", selected: art[0]!.path }, onInterrupt: "fail" });
    expect(done.status).toBe("completed");
    expect(outputsOf(done)["review"]!["round"]).toBe(3);
    expect((done.state["check"] as { round: number }).round).toBe(3);
  });

  it("is 1 at a gate answered once, in every mode", async () => {
    for (const [mode, extra, answer] of [
      ["approve", {}, true],
      ["question", {}, "yes"],
      ["choice", { choices: ["x"] }, "x"],
      ["review", {}, "approve"],
    ] as const) {
      const g = await compile(gateGraph({ mode, ...extra }));
      const t = `r1-${mode}`;
      await g.run({ threadId: t, onInterrupt: "fail" });
      const done = await g.resume({ threadId: t, resume: answer, onInterrupt: "fail" });
      expect(outputsOf(done)["gate"]!["round"]).toBe(1);
    }
  });

  it("ignores a client-sent round", async () => {
    const g = await compile(gateGraph({ mode: "review" }));
    await g.run({ threadId: "forge", onInterrupt: "fail" });
    const done = await g.resume({ threadId: "forge", resume: { decision: "approve", round: 99 }, onInterrupt: "fail" });
    expect(outputsOf(done)["gate"]!["round"]).toBe(1);
  });
});

describe("media variant through a review loop", () => {
  const regen = (variant?: string): GraphSpec =>
    graph(
      [
        img(variant ? { variant } : {}),
        {
          id: "review",
          type: "hitl",
          with: {
            mode: "review",
            message: "Pick",
            decision: ["approve", "regenerate"],
            artifacts: ["{{ state.outputs.img.artifacts }}"],
            select: "one",
            routes: { approve: "END", regenerate: "img" },
            output: { to: "check" },
          },
        },
      ],
      [
        { from: "START", to: "img" },
        { from: "img", to: "review" },
      ],
    );

  it("without a variant, looping back reuses the finished job (no new vendor call)", async () => {
    const g = await compile(regen());
    const f = await g.run({ threadId: "novar", onInterrupt: "fail" });
    const again = await g.resume({ threadId: "novar", resume: { decision: "regenerate" }, onInterrupt: "fail" });
    expect(again.status).toBe("interrupted");
    expect(starts).toHaveLength(1);
    expect(dataOf(again).artifacts.map((a) => a.path)).toEqual(dataOf(f).artifacts.map((a) => a.path));
  });

  it("variant: state.check.round makes a regenerate a new vendor call with new files; round 0 keeps the old fingerprint", async () => {
    const g = await compile(regen("{{ state.check.round }}"));
    const f = await g.run({ threadId: "var", onInterrupt: "fail" });
    expect(starts).toHaveLength(1);
    const first = dataOf(f).artifacts.map((a) => a.path);

    // The same graph without `variant`, in a fresh workspace: identical file names, i.e. identical fingerprint.
    const dir2 = await mkdtemp(path.join(os.tmpdir(), "fg-gate2-"));
    try {
      const plain = await compileGraph(regen(), { cwd: dir2, mediaProviders: [fakeImages([])] });
      const p = await plain.run({ threadId: "var", onInterrupt: "fail" });
      expect(dataOf(p).artifacts.map((a) => a.path)).toEqual(first);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }

    const second = await g.resume({ threadId: "var", resume: { decision: "regenerate" }, onInterrupt: "fail" });
    expect(second.status).toBe("interrupted");
    expect(starts).toHaveLength(2);
    const secondPaths = dataOf(second).artifacts.map((a) => a.path);
    expect(secondPaths).not.toEqual(first);
    expect(secondPaths.some((p) => first.includes(p))).toBe(false);

    const third = await g.resume({ threadId: "var", resume: { decision: "regenerate" }, onInterrupt: "fail" });
    expect(starts).toHaveLength(3);
    expect(dataOf(third).artifacts.map((a) => a.path)).not.toEqual(secondPaths);

    // Variant is a fingerprint input only: vendors never see it.
    for (const req of starts) {
      expect(Object.keys(req)).not.toContain("variant");
      expect(JSON.stringify(req)).not.toContain("variant");
    }
  });

  it("an empty variant renders to nothing and keeps the no-variant fingerprint", async () => {
    const g = await compile(regen("{{ state.check.nothing }}"));
    const f = await g.run({ threadId: "empty", onInterrupt: "fail" });
    const dir2 = await mkdtemp(path.join(os.tmpdir(), "fg-gate3-"));
    try {
      const plain = await compileGraph(regen(), { cwd: dir2, mediaProviders: [fakeImages([])] });
      const p = await plain.run({ threadId: "empty", onInterrupt: "fail" });
      expect(dataOf(f).artifacts.map((a) => a.path)).toEqual(dataOf(p).artifacts.map((a) => a.path));
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});

describe("lint", () => {
  it("warns when select is one/many without artifacts", () => {
    const spec = gateGraph({ mode: "review", select: "one" });
    const d = hitlSelectDiagnostics(spec);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "warning", code: "HITL_SELECT_NO_ARTIFACTS" });
    expect(hitlSelectDiagnostics(gateGraph({ mode: "review", select: "one", artifacts: ["x"] }))).toEqual([]);
    expect(hitlSelectDiagnostics(gateGraph({ mode: "review" }))).toEqual([]);
  });
});
