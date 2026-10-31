import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerFunction } from "@flowgraph/core";
import { RunService } from "./run-service.js";
import type { ServerConfig } from "./types.js";

const COMPLETE_GRAPH = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: hosted-complete
state:
  channels:
    text: { type: string }
    out: { type: string }
nodes:
  - id: echo
    type: function
    with:
      fn: serverEcho
      input: { text: "{{ state.text }}" }
      output: { to: out }
edges:
  - { from: START, to: echo }
  - { from: echo, to: END }
runtime:
  checkpoint: { enabled: true, backend: memory }
`;

describe("RunService", () => {
  let dir: string;
  let service: RunService;

  beforeEach(async () => {
    registerFunction("serverEcho", (input) => {
      const obj = input as { text?: string };
      return obj.text ?? "ok";
    });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-server-"));
    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 0,
      graphStoreDir: dir,
      eventBufferSize: 100,
    };
    service = new RunService(config);
    await service.init();
  });

  afterEach(async () => {
    // The run writes its meta file after startRun returns. close() waits for
    // every pending meta write, so the directory is empty of writers here.
    await service?.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects client secrets", async () => {
    await expect(
      service.startRun({
        threadId: "t1",
        yaml: COMPLETE_GRAPH,
        env: { OPENAI_API_KEY: "x" },
      }),
    ).rejects.toThrow(/reject/);
  });

  it("starts a run and emits events", async () => {
    const threadId = `t-${Date.now()}`;
    const events: string[] = [];
    const unsub = service.registry.subscribe(threadId, (ev) => {
      events.push(String(ev.type));
    });

    const result = await service.startRun({
      threadId,
      yaml: COMPLETE_GRAPH,
      input: { text: "hi" },
    });
    expect(result.status).toBe("started");
    expect(result.runId).toBeTruthy();

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const check = () => {
        const s = service.registry.get(threadId);
        if (s && (s.status === "completed" || s.status === "error" || s.status === "interrupted")) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`timeout waiting for run; status=${s?.status}`));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });

    unsub();
    expect(events).toContain("run.start");
    expect(events).toContain("run.end");
    expect(service.registry.get(threadId)?.status).toBe("completed");
  });

  it("reports importsStripped on start", async () => {
    const threadId = `imports-${Date.now()}`;
    const yaml = COMPLETE_GRAPH.replace(
      "kind: Graph\n",
      "kind: Graph\nimports:\n  - { reducers: \"./register.ts\" }\n",
    );
    const result = await service.startRun({
      threadId,
      yaml,
      input: { text: "hi" },
    });
    expect(result.importsStripped).toBe(true);
  });

  it("persists uploaded yaml", async () => {
    const threadId = `persist-${Date.now()}`;
    await service.startRun({ threadId, yaml: COMPLETE_GRAPH, input: { text: "x" } });
    // Wait briefly for async run
    await new Promise((r) => setTimeout(r, 200));
    const file = path.join(dir, `${threadId}.graph.yaml`);
    const raw = await fs.readFile(file, "utf-8");
    expect(raw).toContain("hosted-complete");
  });

  it("in-memory mode keeps thread state and ctx.store across start -> resume", async () => {
    let preRuns = 0;
    let postSaw: unknown = "post-not-run";
    registerFunction("memPre", async (_i, ctx) => {
      preRuns++;
      await ctx.store?.put(["mem"], "k", { v: "kept" });
      return "pre";
    });
    registerFunction("memPost", async (_i, ctx) => {
      postSaw = (await ctx.store?.get(["mem"], "k"))?.value ?? null;
      return "post";
    });
    const yaml = `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: mem-resume }
state:
  channels:
    approval: { type: object }
nodes:
  - { id: pre, type: function, with: { fn: memPre } }
  - { id: gate, type: hitl, with: { mode: approve, message: "ok?", output: { to: approval } } }
  - { id: post, type: function, with: { fn: memPost } }
edges:
  - { from: START, to: pre }
  - { from: pre, to: gate }
  - { from: gate, to: post }
  - { from: post, to: END }
runtime:
  checkpoint: { enabled: true, backend: memory }
  hitl: { onInterrupt: fail }
`;
    const threadId = `mem-resume-${Date.now()}`;
    const waitFor = async (want: string[]) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const s = service.registry.get(threadId)?.status;
        if (s && want.includes(s)) return s;
        await new Promise((r) => setTimeout(r, 25));
      }
      return service.registry.get(threadId)?.status;
    };
    await service.startRun({ threadId, yaml, input: {} });
    expect(await waitFor(["interrupted", "error"])).toBe("interrupted");
    const mid = (await service.getState(threadId)).state as { next?: string[] };
    expect(mid.next).toEqual(["gate"]);
    await service.resumeRun({ threadId, resume: { approved: true } });
    expect(await waitFor(["completed", "error"])).toBe("completed");
    expect(preRuns).toBe(1);
    expect(postSaw).toEqual({ v: "kept" });
  });

  it("graphs on one service do not see each other's ctx.store keys", async () => {
    const seen: Record<string, unknown> = {};
    registerFunction("storeIso", async (input, ctx) => {
      const who = (input as { who: string }).who;
      seen[`${who}:before`] = (await ctx.store?.get(["shared"], "k"))?.value ?? null;
      await ctx.store?.put(["shared"], "k", { owner: who });
      seen[`${who}:after`] = (await ctx.store?.get(["shared"], "k"))?.value ?? null;
      seen[`${who}:search`] = (await ctx.store?.search(["shared"]))?.map((i) => i.value) ?? null;
      return who;
    });
    const graph = (name: string) => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: ${name} }
state:
  channels:
    out: { type: string }
nodes:
  - { id: n, type: function, with: { fn: storeIso, input: { who: ${name} }, output: { to: out } } }
edges:
  - { from: START, to: n }
  - { from: n, to: END }
runtime:
  checkpoint: { enabled: true, backend: memory }
`;
    const done = async (threadId: string) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const s = service.registry.get(threadId)?.status;
        if (s === "completed" || s === "error") return s;
        await new Promise((r) => setTimeout(r, 25));
      }
      return service.registry.get(threadId)?.status;
    };
    const t1 = `iso-a-${Date.now()}`;
    await service.startRun({ threadId: t1, yaml: graph("graph-a"), input: {} });
    expect(await done(t1)).toBe("completed");
    const t2 = `iso-b-${Date.now()}`;
    await service.startRun({ threadId: t2, yaml: graph("graph-b"), input: {} });
    expect(await done(t2)).toBe("completed");
    expect(seen).toEqual({
      "graph-a:before": null,
      "graph-a:after": { owner: "graph-a" },
      "graph-a:search": [{ owner: "graph-a" }],
      "graph-b:before": null,
      "graph-b:after": { owner: "graph-b" },
      "graph-b:search": [{ owner: "graph-b" }],
    });
  });

  it("resumeRun returns started immediately and completes via events", async () => {
    const HITL_GRAPH = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: hosted-hitl
state:
  channels:
    approval: { type: object }
nodes:
  - id: gate
    type: hitl
    with:
      mode: approve
      message: "Approve?"
      output: { to: approval }
edges:
  - { from: START, to: gate }
  - { from: gate, to: END }
runtime:
  checkpoint: { enabled: true, backend: memory }
  hitl:
    onInterrupt: fail
`;
    const threadId = `resume-${Date.now()}`;
    const events: string[] = [];
    const unsub = service.registry.subscribe(threadId, (ev) => {
      events.push(String(ev.type));
    });

    await service.startRun({ threadId, yaml: HITL_GRAPH, input: {} });

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const check = () => {
        const s = service.registry.get(threadId);
        if (s && (s.status === "interrupted" || s.status === "error")) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`timeout waiting for interrupt; status=${s?.status}`));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
    expect(service.registry.get(threadId)?.status).toBe("interrupted");

    const ack = await service.resumeRun({
      threadId,
      resume: { approved: true },
    });
    expect(ack.status).toBe("started");
    expect(ack.runId).toBeTruthy();

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const check = () => {
        const s = service.registry.get(threadId);
        if (s && (s.status === "completed" || s.status === "error")) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`timeout waiting for resume completion; status=${s?.status}`));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });

    unsub();
    expect(events).toContain("interrupt.raised");
    expect(events).toContain("run.end");
    expect(service.registry.get(threadId)?.status).toBe("completed");
  });

  it("includes persisted metadata after a start", async () => {
    const threadId = `list-${Date.now()}`;
    await service.startRun({
      threadId,
      yaml: COMPLETE_GRAPH,
      input: { text: "hi" },
      label: "Listed",
    });
    await new Promise((r) => setTimeout(r, 200));
    const runs = await service.listRuns();
    expect(runs.some((r) => r.threadId === threadId && r.label === "Listed")).toBe(true);
    const detail = await service.getRun(threadId);
    expect(detail?.yaml).toContain("hosted-complete");
  });
});
