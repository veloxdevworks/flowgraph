import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DemoWithSchema, type GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { compileGraph } from "../compiler.js";
import type { FlowgraphEvent } from "../events.js";
import type { NodeRunContext } from "../context.js";
import { demoArtifactDir, demoNode } from "./demo.js";
import { readDemoManifest } from "./demo-manifest.js";

function demoGraph(withConfig: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "demo-graph" },
    state: { channels: { demo: { type: "object" } } },
    nodes: [
      {
        id: "capture",
        type: "demo",
        with: withConfig,
      },
    ],
    edges: [
      { from: "START", to: "capture" },
      { from: "capture", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false, backend: "memory" } },
  } as unknown as GraphSpec;
}

function mkWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fg-demo-"));
}

describe("DemoWithSchema", () => {
  it("requires exactly one mode", () => {
    expect(DemoWithSchema.safeParse({}).success).toBe(false);
    expect(
      DemoWithSchema.safeParse({
        http: { url: "https://example.com" },
        file: { path: "./a.txt" },
      }).success,
    ).toBe(false);
    expect(DemoWithSchema.safeParse({ http: { url: "https://example.com" } }).success).toBe(true);
    expect(
      DemoWithSchema.safeParse({ screenshot: { url: "https://example.com" } }).success,
    ).toBe(true);
    expect(DemoWithSchema.safeParse({ file: { path: "./out.pdf" } }).success).toBe(true);
  });
});

describe("demo node", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("http mode writes a transcript artifact and maps output", async () => {
    const workspace = mkWorkspace();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ hello: "world" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events: FlowgraphEvent[] = [];
    const compiled = await compileGraph(
      demoGraph({
        label: "api-check",
        http: {
          url: "https://example.com/api",
          method: "GET",
          headers: { Authorization: "Bearer secret" },
        },
        output: { to: "demo" },
      }),
      {
        cwd: workspace,
        sinks: [
          (e) => {
            events.push(e);
          },
        ],
      },
    );

    const result = await compiled.run({ threadId: "demo-http" });
    expect(result.status).toBe("completed");

    const out = result.state["demo"] as {
      ok: boolean;
      kind: string;
      path: string;
      request: { headers: Record<string, string> };
      response: { status: number; body: unknown };
    };
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("http");
    expect(out.response.status).toBe(200);
    expect(out.response.body).toEqual({ hello: "world" });
    expect(out.request.headers.Authorization).toBe("***");
    expect(fs.existsSync(out.path)).toBe(true);
    expect(out.path.startsWith(demoArtifactDir(workspace, "capture"))).toBe(true);

    const transcript = JSON.parse(fs.readFileSync(out.path, "utf8")) as {
      request: { headers: Record<string, string> };
    };
    expect(transcript.request.headers.Authorization).toBe("***");

    const outputEvt = events.find((e) => e.type === "node.output");
    expect(outputEvt?.scope.nodeId).toBe("capture");

    const manifest = readDemoManifest(workspace, "demo-http");
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({
      ok: true,
      kind: "http",
      nodeId: "capture",
      label: "api-check",
    });
    expect(manifest[0]?.path).toBe(out.path);
  });

  it("file mode copies an existing artifact into the demo dir", async () => {
    const workspace = mkWorkspace();
    const source = path.join(workspace, "report.md");
    fs.writeFileSync(source, "# Hello demo\n", "utf8");

    const compiled = await compileGraph(
      demoGraph({
        label: "report",
        file: { path: "./report.md" },
        output: { to: "demo" },
      }),
      { cwd: workspace },
    );

    const result = await compiled.run({ threadId: "demo-file" });
    expect(result.status).toBe("completed");

    const out = result.state["demo"] as {
      ok: boolean;
      kind: string;
      path: string;
      mimeType: string;
      sizeBytes: number;
    };
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("file");
    expect(out.mimeType).toBe("text/markdown");
    expect(out.sizeBytes).toBeGreaterThan(0);
    expect(fs.readFileSync(out.path, "utf8")).toBe("# Hello demo\n");
    expect(out.path).not.toBe(source);
  });

  it("file mode missing source is best-effort (ok:false) by default", async () => {
    const workspace = mkWorkspace();
    const compiled = await compileGraph(
      demoGraph({
        file: { path: "./missing.pdf" },
        output: { to: "demo" },
      }),
      { cwd: workspace },
    );

    const result = await compiled.run({ threadId: "demo-file-missing" });
    expect(result.status).toBe("completed");

    const out = result.state["demo"] as { ok: boolean; kind: string; reason: string };
    expect(out.ok).toBe(false);
    expect(out.kind).toBe("file");
    expect(out.reason).toMatch(/not found/i);
  });

  it("strict: true fails the node when capture fails", async () => {
    const workspace = mkWorkspace();
    const compiled = await compileGraph(
      demoGraph({
        strict: true,
        file: { path: "./missing.pdf" },
      }),
      { cwd: workspace },
    );

    const result = await compiled.run({ threadId: "demo-strict" });
    expect(["failed", "error"]).toContain(result.status);
  });

  it("screenshot mode returns best-effort failure when playwright is missing", async () => {
    const workspace = mkWorkspace();
    // Ensure no local playwright install in the temp workspace.
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "demo-no-pw", private: true }),
      "utf8",
    );

    // Force the bare import path to fail by stubbing dynamic import via a
    // workspace that cannot resolve playwright. If playwright happens to be
    // resolvable from the monorepo, the capture may succeed — either outcome
    // is acceptable as long as the node completes.
    const compiled = await compileGraph(
      demoGraph({
        screenshot: { url: "https://example.com" },
        output: { to: "demo" },
      }),
      { cwd: workspace },
    );

    const result = await compiled.run({ threadId: "demo-screenshot" });
    expect(result.status).toBe("completed");

    const out = result.state["demo"] as {
      ok: boolean;
      kind: string;
      reason?: string;
      path?: string;
    };
    expect(out.kind).toBe("screenshot");
    if (out.ok) {
      expect(out.path).toBeTruthy();
      expect(fs.existsSync(out.path!)).toBe(true);
    } else {
      expect(out.reason).toMatch(/playwright|not installed|browser|launch|navigate|timeout/i);
    }

    const manifest = readDemoManifest(workspace, "demo-screenshot");
    expect(manifest.length).toBeGreaterThanOrEqual(1);
    expect(manifest[0]?.kind).toBe("screenshot");
    expect(manifest[0]?.nodeId).toBe("capture");
  });

  it("tool-style invocation tracks the manifest without requiring graph state", async () => {
    const workspace = mkWorkspace();
    const source = path.join(workspace, "note.txt");
    fs.writeFileSync(source, "hi", "utf8");

    const compiled = demoNode.build(
      { graphName: "tool-demo" },
      { id: "file-tool" },
      {
        label: "{{ input.label }}",
        file: { path: "{{ input.path }}" },
      } as never,
    );

    const ctx = {
      nodeId: "file-tool",
      nodeType: "demo",
      attempt: 1,
      workspace,
      meta: { runId: "run-x", threadId: "tool-thread", startedAt: new Date().toISOString(), graph: "tool-demo" },
      config: {},
      secrets: { get: () => undefined, with: async (_k: string, fn: () => unknown) => fn() },
      events: { emit: () => {}, subscribe: () => () => {} },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      render: (t: string) => t,
      emit: () => {},
      interrupt: () => {
        throw new Error("unexpected interrupt");
      },
      once: async <T>(_k: string, fn: () => Promise<T> | T) => fn(),
      _input: { label: "from-tool", path: "./note.txt" },
    } as unknown as NodeRunContext & { _input: Record<string, unknown> };

    const res = await compiled.run({}, ctx);
    expect(res).toHaveProperty("update");

    const manifest = readDemoManifest(workspace, "tool-thread");
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({
      ok: true,
      kind: "file",
      nodeId: "file-tool",
      label: "from-tool",
    });
  });
});
