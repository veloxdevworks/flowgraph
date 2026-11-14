import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphSpecSchema, type GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "./compiler.js";
import { registerFunction } from "./nodes/function.js";
import type { MediaProvider } from "./media/types.js";
import type { FlowgraphEvent } from "./events.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
function graph(nodes: unknown[], edges: unknown[], runtime = {}): GraphSpec {
  return GraphSpecSchema.parse({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "qa-maps" },
    state: {
      channels: {
        items: { type: "array" },
        results: { type: "array" },
        effects: { type: "array", reducer: "append" },
        round: { type: "number", default: 0 },
      },
    },
    nodes,
    edges,
    runtime,
  });
}
const mapped = (over = "{{ state.items }}", extra = {}) => ({
  id: "fan",
  type: "map",
  with: {
    over,
    as: "n",
    node: {
      type: "function",
      with: { fn: "qaMapValue", input: { n: "{{ item.n }}", round: "{{ state.round }}" } },
    },
    collect: { to: "results" },
    ...extra,
  },
});
const chain = [
  { from: "START", to: "fan" },
  { from: "fan", to: "END" },
];

describe("PLAT-296: concurrency preserves work", () => {
  it.each(["map", "runtime"])("collects every item with %s concurrency 1", async (kind) => {
    const seen: number[] = [];
    registerFunction("qaMapValue", (input) => {
      const n = (input as { n: number }).n;
      seen.push(n);
      return n * 2;
    });
    const spec = graph(
      [mapped(undefined, kind === "map" ? { concurrency: 1 } : {})],
      chain,
      kind === "runtime" ? { concurrency: 1 } : {},
    );
    const result = await (await compileGraph(spec)).run({ input: { items: [1, 2, 3] } });
    expect(result.status).toBe("completed");
    expect(result.state.results).toEqual([2, 4, 6]);
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it("serializes static branches without losing their writes", async () => {
    let active = 0;
    let peak = 0;
    registerFunction("qaStaticBranch", async (input) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return (input as { name: string }).name;
    });
    const nodes = ["a", "b", "c"].map((id) => ({
      id,
      type: "function",
      with: { fn: "qaStaticBranch", input: { name: id }, output: { to: "effects" } },
    }));
    const result = await (
      await compileGraph(
        graph(
          nodes,
          [
            { from: "START", to: ["a", "b", "c"] },
            ...nodes.map((n) => ({ from: n.id, to: "END" })),
          ],
          { concurrency: 1 },
        ),
      )
    ).run();
    expect(result.status).toBe("completed");
    expect([...(result.state.effects as string[])].sort()).toEqual(["a", "b", "c"]);
    expect(peak).toBe(1);
  });

  it("keeps a map cap local while unrelated branches run concurrently", async () => {
    let mapActive = 0;
    let mapPeak = 0;
    let otherActive = 0;
    let otherPeak = 0;
    registerFunction("qaMapValue", async (input) => {
      mapPeak = Math.max(mapPeak, ++mapActive);
      await new Promise((r) => setTimeout(r, 20));
      mapActive--;
      return input;
    });
    registerFunction("qaUnrelated", async () => {
      otherPeak = Math.max(otherPeak, ++otherActive);
      await new Promise((r) => setTimeout(r, 30));
      otherActive--;
      return "done";
    });
    const others = ["a", "b", "c"].map((id) => ({
      id,
      type: "function",
      with: { fn: "qaUnrelated", output: { none: true } },
    }));
    const result = await (
      await compileGraph(
        graph(
          [mapped(undefined, { concurrency: 2 }), ...others],
          [
            { from: "START", to: ["fan", "a", "b", "c"] },
            { from: "fan", to: "END" },
            ...others.map((n) => ({ from: n.id, to: "END" })),
          ],
        ),
      )
    ).run({ input: { items: [1, 2, 3, 4] } });
    expect(result.status).toBe("completed");
    expect((result.state.results as unknown[]).length).toBe(4);
    expect(mapPeak).toBe(2);
    expect(otherPeak).toBe(3);
  });

  it("shares the runtime cap between map workers and static nodes", async () => {
    let active = 0;
    let peak = 0;
    const work = async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return "done";
    };
    registerFunction("qaMapValue", work);
    registerFunction("qaRuntimeOther", work);
    const result = await (
      await compileGraph(
        graph(
          [
            mapped(undefined, { concurrency: 3 }),
            {
              id: "other",
              type: "function",
              with: { fn: "qaRuntimeOther", output: { to: "effects" } },
            },
          ],
          [
            { from: "START", to: ["fan", "other"] },
            { from: "fan", to: "END" },
            { from: "other", to: "END" },
          ],
          { concurrency: 1 },
        ),
      )
    ).run({ input: { items: [1, 2, 3] } });
    expect(result.status).toBe("completed");
    expect(result.state.results).toEqual(["done", "done", "done"]);
    expect(result.state.effects).toEqual(["done"]);
    expect(peak).toBe(1);
  });

  it("cancels queued items without starting their side effects", async () => {
    let started = 0;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    registerFunction("qaMapValue", async (_input, ctx) => {
      started++;
      await new Promise<void>((resolve) => {
        ctx.signal!.addEventListener("abort", () => resolve(), { once: true });
        entered();
      });
      return "stopped";
    });
    const controller = new AbortController();
    const compiled = await compileGraph(
      graph([mapped(undefined, { concurrency: 1 })], chain, { concurrency: 1 }),
    );
    const running = compiled.run({ input: { items: [1, 2, 3] }, signal: controller.signal });
    try {
      await ready;
      controller.abort();
      expect((await running).status).toBe("aborted");
    } finally {
      controller.abort();
    }
    expect(started).toBe(1);
  });

  it("isolates cancellation between invocations of the same compiled graph", async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    registerFunction("qaMapValue", async (input, ctx) => {
      const n = (input as { n: string }).n;
      if (n === "wait") {
        await new Promise<void>((resolve) => {
          ctx.signal!.addEventListener("abort", () => resolve(), { once: true });
          entered();
        });
        ctx.signal!.throwIfAborted();
      }
      ctx.signal?.throwIfAborted();
      return n;
    });
    const controller = new AbortController();
    const compiled = await compileGraph(
      graph([mapped(undefined, { concurrency: 1 })], chain, { concurrency: 1 }),
    );
    const running = compiled.run({ threadId: "cancelled", input: { items: ["wait"] }, signal: controller.signal });
    try {
      await ready;
      controller.abort();
      const other = await compiled.run({ threadId: "unaffected", input: { items: ["keep", "all"] } });
      expect(other.status).toBe("completed");
      expect(other.state.results).toEqual(["keep", "all"]);
      expect((await running).status).toBe("aborted");
    } finally {
      controller.abort();
    }
  });
});

describe("PLAT-311 / PLAT-312 / PLAT-325: map invocation semantics", () => {
  it("collects only the current loop round", async () => {
    registerFunction("qaMapValue", (input) => input);
    registerFunction("qaNextRound", (input) => (input as { n: number }).n + 1);
    const spec = graph(
      [
        mapped(),
        {
          id: "next-round",
          type: "function",
          with: { fn: "qaNextRound", input: { n: "{{ state.round }}" }, output: { to: "round" } },
        },
        {
          id: "route",
          type: "router",
          with: {
            routes: {
              again: { when: "{{ state.round < 2 }}", to: "fan" },
              done: { default: true, to: "END" },
            },
          },
        },
      ],
      [
        { from: "START", to: "fan" },
        { from: "fan", to: "next-round" },
        { from: "next-round", to: "route" },
      ],
    );
    const result = await (await compileGraph(spec)).run({ input: { items: [1, 2] } });
    expect(result.status).toBe("completed");
    expect(result.state.results).toEqual([
      { n: 1, round: 1 },
      { n: 2, round: 1 },
    ]);
  });

  it("projects each result after the inner node runs", async () => {
    registerFunction("qaMapValue", (input) => ({ twice: (input as { n: number }).n * 2 }));
    const result = await (
      await compileGraph(
        graph(
          [
            mapped(undefined, {
              node: {
                type: "function",
                with: {
                  fn: "qaMapValue",
                  input: { n: "{{ item.n }}" },
                  output: { map: { value: "{{ result.twice }}" } },
                },
              },
            }),
          ],
          chain,
        ),
      )
    ).run({ input: { items: [1, 2] } });
    expect(result.status).toBe("completed");
    expect(result.state.results).toEqual([2, 4]);
  });

  it("retains both item and result scopes during the output projection", async () => {
    registerFunction("qaMapValue", () => ({ suffix: "done" }));
    const result = await (
      await compileGraph(
        graph(
          [
            mapped(undefined, {
              node: {
                type: "function",
                with: {
                  fn: "qaMapValue",
                  output: { map: { value: "{{ { item: item.n, result: result.suffix } }}" } },
                },
              },
            }),
          ],
          chain,
        ),
      )
    ).run({ input: { items: ["a", "b"] } });
    expect(result.status).toBe("completed");
    expect(result.state.results).toEqual([
      { item: "a", result: "done" },
      { item: "b", result: "done" },
    ]);
  });

  it("honors the inner retry policy before the map's policy", async () => {
    let attempts = 0;
    registerFunction("qaMapValue", () => {
      if (++attempts === 1) throw new Error("retry me");
      return "ok";
    });
    const node = mapped(undefined, {
      node: {
        type: "function",
        retry: { maxAttempts: 2, baseMs: 1, jitter: false },
        with: { fn: "qaMapValue" },
      },
    });
    const spec = graph([{ ...node, retry: { maxAttempts: 1 } }], chain);
    const result = await (await compileGraph(spec)).run({ input: { items: [1] } });
    expect(result.status).toBe("completed");
    expect(result.state.results).toEqual(["ok"]);
    expect(attempts).toBe(2);
  });

  it("keeps finished items when a sibling interrupts and resumes", async () => {
    registerFunction("qaMapValue", (input, ctx) => {
      if ((input as { n: number }).n === 1) return "finished";
      return ctx.interrupt({ reason: "answer item", kind: "question" });
    });
    const compiled = await compileGraph(graph([mapped(undefined, { concurrency: 1 })], chain));
    const first = await compiled.run({ threadId: "qa-map-resume", input: { items: [1, 2] } });
    expect(first.status).toBe("interrupted");
    const result = await compiled.resume({ threadId: "qa-map-resume", resume: "answered" });
    expect(result.status).toBe("completed");
    expect(result.state.results).toEqual(["finished", "answered"]);
  });
});

describe("PLAT-313 / PLAT-351: item identities", () => {
  it("hides compiler names in breakpoint answers and single-step events", async () => {
    registerFunction("qaMapValue", () => "value");
    const events: FlowgraphEvent[] = [];
    const compiled = await compileGraph(graph([mapped()], chain), {
      interruptAfter: ["fan"],
      sinks: [
        (event) => {
          events.push(event);
        },
      ],
    });
    const first = await compiled.run({ threadId: "qa-map-step", input: { items: [1, 2] } });
    expect(first.status).toBe("interrupted");
    expect(JSON.stringify(first.interrupts)).not.toMatch(/map[wj]_/);
    expect((await compiled.step({ threadId: "qa-map-step" })).status).toBe("paused");
    const pauses = events.filter(
      (event) => event.type === "run.paused" || event.type === "interrupt.raised",
    );
    expect(JSON.stringify(pauses)).not.toMatch(/map[wj]_/);
    expect(
      (pauses.find((event) => event.type === "run.paused")?.data as { next: string[] }).next,
    ).toEqual(["fan"]);
  });
  it("uses separate media journals and artifact paths for two mapped nodes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fg-qa-map-media-"));
    dirs.push(dir);
    let starts = 0;
    const events: FlowgraphEvent[] = [];
    const provider: MediaProvider = {
      name: "qa-media",
      vendor: "qa",
      modalities: ["image"],
      async start(_req, ctx) {
        const id = String(++starts);
        const artifact = await ctx.saveOutput({
          bytes: new Uint8Array([1, 2, 3]),
          mimeType: "image/png",
        });
        return { id, done: [artifact] };
      },
    };
    const mediaMap = (id: string) => ({
      id,
      type: "map",
      with: {
        over: "{{ ['same'] }}",
        node: { type: "image", with: { provider: "qa-media", prompt: "same" } },
        collect: { to: "results" },
      },
    });
    const spec = graph(
      [mediaMap("views-a"), mediaMap("views-b")],
      [
        { from: "START", to: "views-a" },
        { from: "views-a", to: "views-b" },
        { from: "views-b", to: "END" },
      ],
    );
    const result = await (
      await compileGraph(spec, {
        cwd: dir,
        mediaProviders: [provider],
        sinks: [
          (e) => {
            events.push(e);
          },
        ],
      })
    ).run({ threadId: "qa-media-map" });
    expect(result.status).toBe("completed");
    expect(starts).toBe(2);
    const jobs = events
      .filter((e) => e.type === "custom.media.job")
      .map((e) => e.data as { nodeId: string });
    expect(new Set(jobs.map((e) => e.nodeId))).toEqual(new Set(["views-a[0]", "views-b[0]"]));
    expect(JSON.stringify(result.state)).not.toContain("/undefined/");
  });

  it("reports author node names for a pending map rather than compiler IDs", async () => {
    const spec = graph(
      [
        mapped(undefined, {
          node: { type: "hitl", with: { mode: "approve", message: "approve" } },
        }),
      ],
      chain,
    );
    const compiled = await compileGraph(spec);
    const result = await compiled.run({ threadId: "qa-map-names", input: { items: [1, 2] } });
    expect(result.status).toBe("interrupted");
    const snapshot = await compiled.getState("qa-map-names");
    expect(snapshot?.next).toEqual(["fan"]);
  });
});
