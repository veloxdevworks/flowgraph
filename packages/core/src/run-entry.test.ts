import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import { decodeCliInput, resolveGraphInput } from "./inputs.js";
import { createScriptedProvider } from "./providers/index.js";
import type { FlowgraphEvent } from "./events.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg-run-entry-"));
  dirs.push(dir);
  return dir;
}

function graph(nodes: unknown[], extra: Record<string, unknown> = {}): GraphSpec {
  const ids = nodes.map((n) => (n as { id: string }).id);
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "run-entry" },
    state: { channels: { log: { type: "array", reducer: "append", default: [] }, got: { type: "object" }, out: { type: "object" } } },
    nodes,
    edges: [{ from: "START", to: ids[0] }, ...ids.map((id, i) => ({ from: id, to: ids[i + 1] ?? "END" }))],
    ...extra,
  });
}

registerFunction("runEntryEcho", (input) => input);
registerFunction("runEntryLog", (input) => [(input as { tag: string }).tag]);

describe("each start without a thread id is its own run", () => {
  const logGraph = () => graph([{ id: "a", type: "function", with: { fn: "runEntryLog", output: { to: "log" } }, input: { tag: "{{ state.tag }}" } }], {
    state: { channels: { tag: { type: "string" }, log: { type: "array", reducer: "append", default: [] } } },
  });

  it("gives every run() a fresh run id and thread, so state does not carry over", async () => {
    const compiled = await compileGraph(logGraph(), { workspace: workspace() });
    const first = await compiled.run({ input: { tag: "first" } });
    const second = await compiled.run({ input: { tag: "second" } });
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(first.state.log).toEqual(["first"]);
    expect(second.state.log).toEqual(["second"]);
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.runId).not.toBe(first.runId);
    expect(first.runId).not.toBe(compiled.runId);
    expect(first.threadId).toBe(`thread-${first.runId}`);
  });

  it("labels each run's events with that run's id", async () => {
    const compiled = await compileGraph(logGraph(), { workspace: workspace() });
    const events: FlowgraphEvent[] = [];
    compiled.events.subscribe((e) => { events.push(e); });
    const first = await compiled.run({ input: { tag: "first" } });
    const second = await compiled.run({ input: { tag: "second" } });
    const starts = events.filter((e) => e.type === "run.start");
    expect(starts.map((e) => [e.runId, e.threadId])).toEqual([
      [first.runId, first.threadId],
      [second.runId, second.threadId],
    ]);
    expect(events.filter((e) => e.runId === first.runId).every((e) => e.threadId === first.threadId)).toBe(true);
  });

  it("uses a UUID run id and names the thread after it", async () => {
    const compiled = await compileGraph(logGraph(), { workspace: workspace() });
    const r = await compiled.run({ input: { tag: "first" } });
    expect(r.runId).toMatch(/^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(compiled.runId).toMatch(/^run-[0-9a-f-]{36}$/);
    expect(r.threadId).toBe(`thread-${r.runId}`);
  });

  it("treats an empty thread id as absent", async () => {
    const compiled = await compileGraph(logGraph(), { workspace: workspace() });
    const first = await compiled.run({ threadId: "", input: { tag: "first" } });
    const second = await compiled.run({ threadId: "", input: { tag: "second" } });
    expect(first.status).toBe("completed");
    expect(first.threadId).toBe(`thread-${first.runId}`);
    expect(first.runId).not.toBe(compiled.runId);
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.state.log).toEqual(["second"]);
    const prepared = await compiled.prepare({ mode: "start", options: { threadId: "", input: { tag: "third" } } });
    const third = await prepared.execute();
    expect(third.runId).toBe(prepared.runId);
    expect(third.threadId).toBe(`thread-${prepared.runId}`);
    const threads = new Set<string | undefined>();
    for await (const event of compiled.stream({ threadId: "", input: { tag: "fourth" } })) {
      if (event.type === "run.start") threads.add(event.threadId);
    }
    expect([...threads]).toHaveLength(1);
    expect([...threads][0]).toMatch(/^thread-run-/);
    expect(threads.has(third.threadId)).toBe(false);
  });

  it("treats a whitespace-only thread id as absent", async () => {
    const compiled = await compileGraph(logGraph(), { workspace: workspace() });
    const first = await compiled.run({ threadId: "   ", input: { tag: "first" } });
    const second = await compiled.run({ threadId: " \t\n", input: { tag: "second" } });
    expect(first.status).toBe("completed");
    expect(first.threadId).toBe(`thread-${first.runId}`);
    expect(first.runId).not.toBe(compiled.runId);
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.state.log).toEqual(["second"]);
    const prepared = await compiled.prepare({ mode: "start", options: { threadId: "  ", input: { tag: "third" } } });
    expect((await prepared.execute()).threadId).toBe(`thread-${prepared.runId}`);
    const kept = await compiled.run({ threadId: " padded ", input: { tag: "kept" } });
    expect(kept.threadId).toBe(" padded ");
  });

  it("keeps the caller's thread, and continues its state, when a thread id is given", async () => {
    const compiled = await compileGraph(logGraph(), { workspace: workspace() });
    const first = await compiled.run({ threadId: "shared", input: { tag: "first" } });
    const second = await compiled.run({ threadId: "shared", input: { tag: "second" } });
    expect(first.threadId).toBe("shared");
    expect(second.state.log).toEqual(["first", "second"]);
    expect(first.runId).toBe(compiled.runId);
  });

  it("streams a fresh thread per call", async () => {
    const compiled = await compileGraph(logGraph(), { workspace: workspace() });
    const threads = new Set<string | undefined>();
    for (const tag of ["first", "second"]) {
      for await (const event of compiled.stream({ input: { tag } })) {
        if (event.type === "run.start") threads.add(event.threadId);
      }
    }
    expect(threads.size).toBe(2);
  });

  it("does not share a token budget between unrelated runs", async () => {
    const provider = createScriptedProvider("run-entry-qa", (_req, ctx) => {
      const usage = { totalTokens: 1 };
      ctx.emit("usage", usage);
      return { output: "done", usage, stopReason: "done" };
    });
    const spec = graph([{ id: "a", type: "agent", provider: "run-entry-qa", with: { prompt: "answer" } }], {
      runtime: { budget: { maxTokens: 1, onExceed: "fail" } },
    });
    const compiled = await compileGraph(spec, { providers: [provider], workspace: workspace() });
    const first = await compiled.run();
    const second = await compiled.run();
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(second.usage?.totalTokens).toBe(1);
  });
});

describe("compiled.run() resolves graph inputs like the CLI and server", () => {
  const inputsGraph = () => graph([{ id: "a", type: "function", with: { fn: "runEntryEcho", output: { to: "got" } }, input: { all: "{{ state }}" } }], {
    state: { channels: { got: { type: "object" }, name: { type: "string" }, greeting: { type: "string" }, count: { type: "number" }, seed: { type: "string" } } },
    inputs: [
      { key: "name", required: true },
      { key: "greeting", default: "hey" },
      { key: "count", type: "number" },
      { key: "seed", default: "from-graph" },
    ],
  });

  it("rejects a missing required input with INPUT_INVALID before anything runs", async () => {
    const compiled = await compileGraph(inputsGraph(), { workspace: workspace() });
    const events: FlowgraphEvent[] = [];
    compiled.events.subscribe((e) => { events.push(e); });
    await expect(compiled.run({ input: {} })).rejects.toMatchObject({ code: "INPUT_INVALID", name: "InputValidationError" });
    await expect(compiled.run({ input: {} })).rejects.toThrow(/missing required input: name/);
    expect(events.filter((e) => e.type === "run.start")).toHaveLength(0);
  });

  it("applies defaults and seeds declared inputs as they are", async () => {
    const compiled = await compileGraph(inputsGraph(), { workspace: workspace() });
    const r = await compiled.run({ input: { name: "Ada", count: 3 } });
    expect(r.status).toBe("completed");
    expect(r.state.got).toMatchObject({ all: { name: "Ada", greeting: "hey", count: 3, seed: "from-graph" } });
  });

  it("validates stream() and prepare() starts the same way", async () => {
    const compiled = await compileGraph(inputsGraph(), { workspace: workspace() });
    const stream = compiled.stream({ input: {} })[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(compiled.prepare({ mode: "start", options: { threadId: "p1", input: { count: "x" } } })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    const prepared = await compiled.prepare({ mode: "start", options: { threadId: "p2", input: { name: "Ada" } } });
    await expect(prepared.execute({ input: {} })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    const ok = await prepared.execute();
    expect(ok.status).toBe("completed");
    expect(ok.state.got).toMatchObject({ all: { name: "Ada", greeting: "hey" } });
  });

  it("gives prepare() without a thread id its own run and thread", async () => {
    const compiled = await compileGraph(inputsGraph(), { workspace: workspace() });
    const one = await compiled.prepare({ mode: "start", options: { input: { name: "a" } } });
    const two = await compiled.prepare({ mode: "start", options: { input: { name: "b" } } });
    expect(one.runId).not.toBe(two.runId);
    const [r1, r2] = [await one.execute(), await two.execute()];
    expect(r1.runId).toBe(one.runId);
    expect(r1.threadId).not.toBe(r2.threadId);
  });
});

describe("a node's input is the payload its handler receives", () => {
  it("passes node-level input to a function handler", async () => {
    const spec = graph([{ id: "a", type: "function", input: { x: "hello", who: "{{ state.out }}" }, with: { fn: "runEntryEcho", output: { to: "got" } } }]);
    const r = await (await compileGraph(spec, { workspace: workspace() })).run({ input: { out: { k: 1 } } });
    expect(r.status).toBe("completed");
    expect(r.state.got).toEqual({ x: "hello", who: { k: 1 } });
  });

  it("refuses with.input: the node's own input is the only path", async () => {
    const spec = graph([{ id: "a", type: "function", with: { fn: "runEntryEcho", input: { y: "x" }, output: { to: "got" } } }]);
    await expect(compileGraph(spec, { workspace: workspace() })).rejects.toThrow(/with\.input was removed/);
  });

  it("passes any value as the node input, rendering templates at every depth", async () => {
    for (const [input, expected] of [
      [["{{ state.n }}", { deep: ["{{ state.n }}"] }], [7, { deep: [7] }]],
      ["{{ state.n }}", 7],
      [3, 3],
      [false, false],
    ] as Array<[unknown, unknown]>) {
      const spec = graph([{ id: "a", type: "function", input, with: { fn: "runEntryEcho", output: { to: "got" } } }], {
        state: { channels: { n: { type: "number" }, got: { type: "any" } } },
      });
      const r = await (await compileGraph(spec, { workspace: workspace() })).run({ input: { n: 7 } });
      expect(r.status, JSON.stringify(input)).toBe("completed");
      expect(r.state.got).toEqual(expected);
    }
  });

  it("passes node-level input to a shell command as FLOWGRAPH_INPUT", async () => {
    const print = { command: process.execPath, args: ["-e", "process.stdout.write(process.env.FLOWGRAPH_INPUT ?? 'unset')"] };
    const spec = graph([
      { id: "a", type: "shell", input: { x: "hello" }, with: { ...print, output: { map: { got: "{{ result.json }}" } } } },
      { id: "b", type: "shell", with: { ...print, output: { map: { out: "{{ { raw: result.stdout } }}" } } } },
    ]);
    const r = await (await compileGraph(spec, { workspace: workspace() })).run();
    expect(r.status).toBe("completed");
    expect(r.state.got).toEqual({ x: "hello" });
    expect(r.state.out).toEqual({ raw: "unset" });
  });

  it("writes node-level input to a shell command's stdin", async () => {
    const readStdin = { command: process.execPath, args: ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d||'empty'))"] };
    const spec = graph([
      { id: "a", type: "shell", input: { x: "hello", n: "{{ state.out.n }}" }, with: { ...readStdin, output: { map: { got: "{{ result.json }}" } } } },
      { id: "b", type: "shell", with: { ...readStdin, output: { map: { out: "{{ { raw: result.stdout } }}" } } } },
    ]);
    const r = await (await compileGraph(spec, { workspace: workspace() })).run({ input: { out: { n: 2 } } });
    expect(r.status).toBe("completed");
    expect(r.state.got).toEqual({ x: "hello", n: 2 });
    expect(r.state.out).toEqual({ raw: "empty" });
  });
});

describe("a generated thread keeps its run id after a pause", () => {
  const gateGraph = () => graph([{ id: "gate", type: "hitl", with: { mode: "approve", message: "ok?" } }]);

  it("reports the same run id on run(), resume() and their events", async () => {
    const compiled = await compileGraph(gateGraph(), { workspace: workspace(), checkpointer: "memory" });
    const events: FlowgraphEvent[] = [];
    compiled.events.subscribe((e) => { events.push(e); });
    const started = await compiled.run();
    expect(started.status).toBe("interrupted");
    expect(started.runId).not.toBe(compiled.runId);
    const resumed = await compiled.resume({ threadId: started.threadId!, resume: { approved: true } });
    expect(resumed.status).toBe("completed");
    expect(resumed.runId).toBe(started.runId);
    expect(new Set(events.map((e) => e.runId))).toEqual(new Set([started.runId]));
  });

  it("reports the run id from a resume prepare()", async () => {
    const ws = workspace();
    const compiled = await compileGraph(gateGraph(), { workspace: ws, checkpointer: "memory" });
    const started = await compiled.run();
    const prepared = await compiled.prepare({ mode: "resume", options: { threadId: started.threadId!, resume: { approved: true } } });
    expect(prepared.runId).toBe(started.runId);
    await prepared.release();
  });

  it("keeps the compile-time run id for a caller-supplied thread", async () => {
    const compiled = await compileGraph(gateGraph(), { workspace: workspace(), checkpointer: "memory" });
    const started = await compiled.run({ threadId: "thread-run-not-a-uuid" });
    const resumed = await compiled.resume({ threadId: "thread-run-not-a-uuid", resume: { approved: true } });
    expect(started.runId).toBe(compiled.runId);
    expect(resumed.runId).toBe(compiled.runId);
  });
});

describe("graph inputs are resolved once", () => {
  const jsonGraph = () => graph([{ id: "a", type: "function", with: { fn: "runEntryEcho", output: { to: "got" } }, input: { cfg: "{{ state.cfg }}" } }], {
    state: { channels: { got: { type: "object" }, cfg: { type: "any" } } },
    inputs: [{ key: "cfg", type: "json" }],
  });

  it.each([42, true, { a: 1 }, "42", null])("passes the json input %j through as it is, resolved or not", async (value) => {
    const compiled = await compileGraph(jsonGraph(), { workspace: workspace() });
    const direct = await compiled.run({ input: { cfg: value } });
    expect(direct.status).toBe("completed");
    expect(direct.state.cfg).toEqual(value);
    const resolved = resolveGraphInput(compiled.spec, { cfg: value });
    expect(resolved).toEqual({ cfg: value });
    expect(resolveGraphInput(compiled.spec, resolved)).toEqual(resolved);
    const preResolved = await compiled.run({ input: resolved });
    expect(preResolved.state.cfg).toEqual(value);
  });

  it.each([
    ["42", 42],
    ["true", true],
    ['{"a":1}', { a: 1 }],
  ])("decodes CLI text %s once, by the declared type", async (text, value) => {
    const compiled = await compileGraph(jsonGraph(), { workspace: workspace() });
    const decoded = decodeCliInput(compiled.spec, { cfg: text });
    expect(decoded).toEqual({ cfg: value });
    const r = await compiled.run({ input: decoded });
    expect(r.state.cfg).toEqual(value);
  });

  it("rejects CLI text that is not JSON for a json input", async () => {
    const compiled = await compileGraph(jsonGraph(), { workspace: workspace() });
    expect(() => decodeCliInput(compiled.spec, { cfg: "{nope" })).toThrowError(expect.objectContaining({ code: "INPUT_INVALID" }));
  });
});
