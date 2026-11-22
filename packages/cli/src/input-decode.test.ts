import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const GRAPH = `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: typed }
inputs:
  - { key: count, type: number, required: true }
  - { key: on, type: boolean }
  - { key: label, type: string }
  - { key: filters, type: json }
state:
  channels:
    note: { type: any }
nodes:
  - id: show
    type: shell
    input: { count: "{{ state.count }}", on: "{{ state.on }}", label: "{{ state.label }}", filters: "{{ state.filters }}", note: "{{ state.note }}" }
    with:
      command: cat
      output: none
edges:
  - { from: START, to: show }
  - { from: show, to: END }
runtime: { checkpoint: { enabled: false } }
`;

function run(...inputs: string[]) {
  dir ??= mkdtempSync(join(tmpdir(), "fg-input-decode-"));
  writeFileSync(join(dir, "flow.yaml"), GRAPH);
  const args = inputs.flatMap((value) => ["--input", value]);
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../dist/bin.js"), "run", "flow.yaml", "--json", ...args], {
    cwd: dir,
    encoding: "utf-8",
  });
  const events = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { type: string; data: { state?: Record<string, unknown>; stdout?: string } });
  return { status: result.status, stderr: result.stderr, events };
}

const received = (events: ReturnType<typeof run>["events"]) =>
  JSON.parse(events.find((e) => e.type === "node.output")!.data.stdout!) as Record<string, unknown>;

describe("flowgraph run --input", () => {
  it("decodes each value once, by the type the graph declares", () => {
    const r = run("count=7", "on=true", "label=007", 'filters={"a":[1]}', "note=[1,2]");
    expect(r.status).toBe(0);
    expect(received(r.events)).toEqual({ count: 7, on: true, label: "007", filters: { a: [1] }, note: [1, 2] });
  });

  it("keeps text that only looks like JSON as text for a string input", () => {
    const r = run("count=1", "label=true", "note=plain words");
    expect(r.status).toBe(0);
    expect(received(r.events)).toMatchObject({ count: 1, label: "true", note: "plain words" });
  });

  it("fails with the declared type in the message when text does not decode", () => {
    const r = run("count=seven");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("count (count): expected a number");
    expect(run("count=1", "on=yes").stderr).toContain("expected a boolean");
    expect(run("count=1", "filters={nope").stderr).toContain("invalid JSON");
  });

  it("rejects a key the graph does not declare", () => {
    const r = run("count=1", "surprise=2");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown input "surprise"');
  });

  it("rejects a missing required input", () => {
    const r = run("label=x");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing required input: count");
  });
});
