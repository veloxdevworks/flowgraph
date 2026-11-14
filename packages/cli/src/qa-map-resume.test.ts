import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("checkpointed maps across CLI processes", () => {
  it("retains a finished item and the dispatch round when resuming SQLite", () => {
    dir = mkdtempSync(join(tmpdir(), "fg-qa-map-cli-"));
    const effectFile = join(dir, "effects.txt");
    const core = pathToFileURL(resolve(import.meta.dirname, "../../core/dist/index.js")).href;
    writeFileSync(
      join(dir, "register.mjs"),
      `
      import { registerFunction } from ${JSON.stringify(core)};
      import { appendFileSync } from 'node:fs';
      registerFunction('qaDurableMap', (input, ctx) => {
        if (input.n === 1) { appendFileSync(${JSON.stringify(effectFile)}, 'finished\\n'); return 'finished'; }
        return ctx.interrupt({ reason: 'answer second item', kind: 'question' });
      });
      export default [];
    `,
    );
    writeFileSync(
      join(dir, "flow.yaml"),
      JSON.stringify({
        apiVersion: "flowgraph/v1",
        kind: "Graph",
        metadata: { name: "durable-map" },
        imports: [{ nodes: "./register.mjs" }],
        state: {
          channels: { items: { type: "array", default: [1, 2] }, results: { type: "array" } },
        },
        nodes: [
          {
            id: "fan",
            type: "map",
            with: {
              over: "{{ state.items }}",
              as: "n",
              concurrency: 1,
              node: {
                type: "function",
                with: { fn: "qaDurableMap", input: { n: "{{ item.n }}" } },
              },
              collect: { to: "results" },
            },
          },
        ],
        edges: [
          { from: "START", to: "fan" },
          { from: "fan", to: "END" },
        ],
        runtime: { checkpoint: { backend: "sqlite", path: "checkpoints.sqlite" } },
      }),
    );
    const bin = resolve(import.meta.dirname, "../dist/bin.js");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: "utf8", timeout: 25_000 });
    const first = run("run", "flow.yaml", "--thread", "qa-durable", "--json");
    expect(first.status, first.stdout + first.stderr).toBe(3);
    const resumed = run(
      "resume",
      "flow.yaml",
      "--thread",
      "qa-durable",
      "--resume",
      '"answered"',
      "--json",
    );
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    const events = resumed.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.find((event) => event.type === "run.end")?.data.state.results).toEqual([
      "finished",
      "answered",
    ]);
    expect(readFileSync(effectFile, "utf8")).toBe("finished\n");
  }, 60_000);
});
