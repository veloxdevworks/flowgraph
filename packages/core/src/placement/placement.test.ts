import { describe, it, expect } from "vitest";
import type { GraphSpec, NodeSpec } from "@flowgraph/spec";
import {
  RESERVED_LABEL_NAMESPACES,
  detectBuiltinLabels,
  detectBuiltinLabelsSync,
  parseCustomLabels,
  runLabelChecks,
  hostLabels,
  parseTopology,
  resolveTargetToken,
  effectiveRequirements,
  resolvePlacements,
  createFakeTransport,
} from "./index.js";
import { compileGraph } from "../compiler.js";
import { PlacementUnsatisfiedError } from "./errors.js";
import { registry } from "../registry.js";

const g = (nodes: unknown[], edges: unknown[] = []) =>
  ({ apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "p" }, state: { channels: {} }, nodes, edges }) as unknown as GraphSpec;
const sh = (id: string, runsOn?: unknown): NodeSpec =>
  ({ id, type: "shell", with: { command: "true" }, ...(runsOn ? { runsOn } : {}) }) as unknown as NodeSpec;
const node = (n: unknown) => n as NodeSpec;

describe("label detection", () => {
  it("maps platform names and arch", () => {
    const l = (platform: NodeJS.Platform) => detectBuiltinLabelsSync({ platform, arch: "x64", nodeTypes: [], version: "0.42.7" });
    expect(l("darwin")).toEqual(["os:macos", "arch:x64", "flowgraph:0.42"]);
    expect(l("win32")).toContain("os:windows");
    expect(l("linux")).toContain("os:linux");
    expect(l("freebsd")).toContain("os:freebsd");
  });

  it("adds nodeType for registered types and plugin labels", () => {
    const l = detectBuiltinLabelsSync({ plugins: ["@acme/cc5-nodes"] });
    for (const t of registry.types()) expect(l).toContain(`nodeType:${t}`);
    expect(l).toContain("nodeType:shell");
    expect(l).toContain("plugin:@acme/cc5-nodes");
    expect(l.some((x) => /^flowgraph:\d+\.\d+$/.test(x))).toBe(true);
  });

  it("probes gpu labels and never throws", async () => {
    const apple = await detectBuiltinLabels({ platform: "darwin", arch: "arm64", hasBinary: async () => false });
    expect(apple).toContain("gpu:apple");
    const nv = await detectBuiltinLabels({ platform: "linux", hasBinary: async (n) => n === "nvidia-smi" });
    expect(nv).toContain("gpu:nvidia");
    const boom = await detectBuiltinLabels({ platform: "linux", hasBinary: async () => { throw new Error("x"); } });
    expect(boom).not.toContain("gpu:nvidia");
    const slow = await detectBuiltinLabels({ platform: "linux", probeTimeoutMs: 20, hasBinary: () => new Promise(() => {}) });
    expect(slow).not.toContain("gpu:nvidia");
  });
});

describe("custom labels", () => {
  it("rejects reserved namespaces and malformed labels", () => {
    for (const ns of RESERVED_LABEL_NAMESPACES) expect(() => parseCustomLabels({ [`${ns}:x`]: {} }), ns).toThrow(/reserved/);
    expect(() => parseCustomLabels({ "no-namespace": {} })).toThrow(/Invalid placement label/);
    expect(() => parseCustomLabels({ "app:x": { check: [] } })).toThrow();
    expect(parseCustomLabels({ "app:cc5": { check: ["x"], every: "10m" } })).toEqual({ "app:cc5": { check: ["x"], every: "10m" } });
    expect(parseCustomLabels(["app:blender"])).toEqual({ "app:blender": {} });
  });

  it("runLabelChecks: pass, fail, timeout, missing binary, no check", async () => {
    const node = process.execPath;
    const now = () => new Date("2026-01-01T00:00:00Z");
    const r = await runLabelChecks(
      {
        "app:ok": { check: [node, "-e", "process.exit(0)"] },
        "app:bad": { check: [node, "-e", "console.error('nope');process.exit(1)"] },
        "app:slow": { check: [node, "-e", "setTimeout(()=>{},10000)"] },
        "app:missing": { check: ["definitely-not-a-binary-xyz"] },
        "site:none": {},
      },
      { timeoutMs: 500, now },
    );
    expect(r["app:ok"]).toEqual({ ok: true, checkedAt: "2026-01-01T00:00:00.000Z" });
    expect(r["app:bad"]!.ok).toBe(false);
    expect(r["app:bad"]!.error).toMatch(/exited 1.*nope/);
    expect(r["app:slow"]!.error).toMatch(/timed out/);
    expect(r["app:missing"]!.error).toMatch(/not found/);
    expect(r["site:none"]!.ok).toBe(true);
  });

  it("hostLabels includes passing/unchecked customs only", () => {
    const cfg = { "app:a": { check: ["x"] }, "app:b": { check: ["x"] }, "app:c": { check: ["x"] }, "site:d": {} };
    const res = { "app:a": { ok: true, checkedAt: "t" }, "app:b": { ok: false, checkedAt: "t" } };
    expect(hostLabels(["os:linux"], cfg, res)).toEqual(["os:linux", "app:a", "site:d"]);
  });
});

describe("topology", () => {
  it("parses targets and local labels", () => {
    const { topology, diagnostics } = parseTopology({
      targets: { "studio-pc": { url: "https://studio-pc.lan:8787", token: "env:T", labels: ["os:windows"] } },
      local: { labels: ["app:blender"] },
    });
    expect(diagnostics).toEqual([]);
    expect(topology.local?.labels).toEqual({ "app:blender": {} });
    expect(topology.targets!["studio-pc"]!.url).toContain("studio-pc");
  });

  it("reports diagnostics for bad names, urls, reserved local labels, unknown keys", () => {
    for (const bad of [
      { targets: { "1bad": { url: "http://x" } } },
      { targets: { ok: { url: "not a url" } } },
      { local: { labels: ["os:windows"] } },
      { targets: {}, extra: 1 },
    ]) {
      const r = parseTopology(bad);
      expect(r.diagnostics[0]?.code).toBe("TOPOLOGY_INVALID");
    }
  });

  it("resolves env tokens", () => {
    expect(resolveTargetToken({ token: "env:T" }, { T: "s3" })).toBe("s3");
    expect(resolveTargetToken({ token: "literal" }, {})).toBe("literal");
    expect(resolveTargetToken({}, {})).toBeUndefined();
    expect(() => resolveTargetToken({ token: "env:MISSING" }, {})).toThrow(/MISSING/);
  });
});

describe("effectiveRequirements", () => {
  it("adds declared labels only for core node types", () => {
    expect(effectiveRequirements(sh("a", ["os:windows", "os:windows"]))).toEqual(["os:windows"]);
  });
  it("infers nodeType for non-core types, inline subgraph, map inner and uses children", () => {
    const n = node({
      id: "sg",
      type: "subgraph",
      runsOn: ["app:cc5"],
      spec: g([
        { id: "a", type: "cc5-character" },
        { id: "m", type: "map", with: { node: { id: "i", type: "acme-thing" } } },
        { id: "s", type: "subgraph", uses: "./child.yaml" },
      ]),
    });
    const loadChild = (ref: string) => (ref === "./child.yaml" ? g([{ id: "z", type: "deep-type" }]) : undefined);
    expect(effectiveRequirements(n, { loadChild })).toEqual([
      "app:cc5",
      "nodeType:acme-thing",
      "nodeType:cc5-character",
      "nodeType:deep-type",
    ]);
    expect(effectiveRequirements(n)).not.toContain("nodeType:deep-type");
  });
  it("includes the node's own non-core type", () => {
    expect(effectiveRequirements(node({ id: "x", type: "cc5-character", runsOn: ["os:windows"] }))).toEqual(["os:windows", "nodeType:cc5-character"]);
  });
});

describe("resolvePlacements", () => {
  const url = "http://x";
  const topology = { targets: { a: { url }, b: { url } } };
  const info = (labels: string[], extra = {}) => ({ labels, flowgraphVersion: "0.1.0", ...extra });
  const run = (n: NodeSpec, o: Parameters<typeof resolvePlacements>[1]) => resolvePlacements(g([n]), o);

  it("1: local satisfies and target unset or local", async () => {
    for (const runsOn of [["os:linux"], { labels: ["os:linux"], target: "local" }]) {
      const r = await run(sh("n", runsOn), { localLabels: ["os:linux"] });
      expect(r.decisions[0]).toMatchObject({ kind: "local", target: "local" });
      expect(r.diagnostics).toEqual([]);
    }
  });

  it("2: picks the first matching target that passes preflight; skips unreachable and failed preflight", async () => {
    const topo = { targets: { a: { url }, b: { url }, d: { url }, c: { url } } };
    const t2 = createFakeTransport({ a: { labels: new Error("ECONNREFUSED") }, b: { labels: info(["os:windows"]), preflight: { ok: false, diagnostics: [{ severity: "error", code: "X", message: "binary missing" }] } }, d: { labels: info(["os:linux"]) }, c: { labels: info(["os:windows"]) } });
    const r = await run(sh("n", ["os:windows"]), { localLabels: ["os:macos"], topology: topo, transport: t2 });
    const d = r.decisions[0]!;
    expect(d).toMatchObject({ kind: "remote", target: "c" });
    expect(d.candidates.map((c) => [c.target, c.status])).toEqual([
      ["local", "local-mismatch"],
      ["a", "unreachable"],
      ["b", "preflight-failed"],
      ["d", "no-match"],
      ["c", "matched"],
    ]);
    expect(t2.preflightCalls.map((c) => c.target)).toEqual(["b", "c"]);
    expect(t2.preflightCalls[0]!.req.spec.nodes[0]!.id).toBe("n");
    expect((t2.preflightCalls[0]!.req.spec.nodes[0] as NodeSpec).runsOn).toBeUndefined();
  });

  it("preflight gets the inline subgraph spec", async () => {
    const child = g([sh("inner")]);
    const t = createFakeTransport({ a: { labels: info(["os:windows"]) } });
    await run(node({ id: "sg", type: "subgraph", spec: child, runsOn: ["os:windows"] }), { localLabels: [], topology, transport: t });
    expect(t.preflightCalls[0]!.req.spec).toBe(child);
  });

  it("target pin restricts candidates; unknown pin is reported", async () => {
    const t = createFakeTransport({ a: { labels: info(["os:windows"]) }, b: { labels: info(["os:windows"]) } });
    const pinned = await run(sh("n", { labels: ["os:windows"], target: "b" }), { localLabels: ["os:windows"], topology, transport: t });
    expect(pinned.decisions[0]).toMatchObject({ kind: "remote", target: "b" });
    const missing = await run(sh("n", { labels: ["os:windows"], target: "zzz" }), { localLabels: [], topology, transport: t });
    expect(missing.decisions[0]!.kind).toBe("unsatisfied");
    expect(missing.decisions[0]!.candidates[0]!.status).toBe("not-in-topology");
  });

  it("3: fallback local", async () => {
    const r = await run(sh("n", { labels: ["gpu:nvidia"], fallback: "local" }), { localLabels: [] });
    expect(r.decisions[0]).toMatchObject({ kind: "local", target: "local" });
    expect(r.diagnostics).toEqual([]);
  });

  it("4: wait queues", async () => {
    const r = await run(sh("n", { labels: ["gpu:nvidia"], wait: "30m" }), { localLabels: [] });
    expect(r.decisions[0]!.kind).toBe("queued");
    expect(r.diagnostics).toEqual([]);
  });

  it("5: PLACEMENT_UNSATISFIED with the ADR message shape", async () => {
    const t = createFakeTransport({
      a: { labels: info(["os:windows"], { checks: { "app:cc5": { ok: false, checkedAt: new Date(Date.now() - 180_000).toISOString(), error: "check exited 1" } } }) },
      b: { labels: info(["os:linux"]) },
    });
    const r = await run(sh("character", ["os:windows", "app:cc5"]), { localLabels: ["os:macos"], topology, transport: t });
    expect(r.decisions[0]!.kind).toBe("unsatisfied");
    const d = r.diagnostics[0]!;
    expect(d.code).toBe("PLACEMENT_UNSATISFIED");
    expect(d.message).toContain('node "character" needs [os:windows, app:cc5]');
    expect(d.message).toMatch(/\n {2}a +app:cc5 withdrawn 3m ago \(check exited 1\)/);
    expect(d.message).toMatch(/\n {2}b +os:linux {2}no match on os:windows, app:cc5/);
  });

  it("no transport: targets are reported unreachable", async () => {
    const r = await run(sh("n", ["os:windows"]), { localLabels: [], topology });
    expect(r.decisions[0]!.candidates.map((c) => c.status)).toEqual(["local-mismatch", "unreachable", "unreachable"]);
  });

  it("ignores unplaced nodes", async () => {
    const r = await run(sh("n"), { localLabels: [] });
    expect(r.decisions).toEqual([]);
  });
});

describe("compileGraph placement guard", () => {
  it("throws PlacementUnsatisfiedError for an unsatisfiable node", async () => {
    const spec = g([sh("a", ["os:windows"])], [{ from: "START", to: "a" }, { from: "a", to: "END" }]);
    const err = await compileGraph(spec, { checkpointer: "none", placement: { localLabels: ["os:macos"] } }).catch((e) => e);
    expect(err).toBeInstanceOf(PlacementUnsatisfiedError);
    expect(err.code).toBe("PLACEMENT_UNSATISFIED");
    expect(err.decisions[0].nodeId).toBe("a");
    expect(err.message).toContain('node "a" needs [os:windows]');
  });

  it("compiles when satisfied locally or fallback is local; unaffected without runsOn", async () => {
    const edges = [{ from: "START", to: "a" }, { from: "a", to: "END" }];
    for (const runsOn of [["os:macos"], { labels: ["os:windows"], fallback: "local" }, undefined]) {
      const spec = g([sh("a", runsOn)], edges);
      await expect(compileGraph(spec, { checkpointer: "none", placement: { localLabels: ["os:macos"] } })).resolves.toBeDefined();
    }
  });

  it("defaults local labels to detected built-ins", async () => {
    const here = detectBuiltinLabelsSync().find((l) => l.startsWith("os:"))!;
    const spec = g([sh("a", [here])], [{ from: "START", to: "a" }, { from: "a", to: "END" }]);
    await expect(compileGraph(spec, { checkpointer: "none" })).resolves.toBeDefined();
  });
});
