import { describe, expect, it } from "vitest";
import { migrateSpec } from "./migrate.js";
import { migrateDataContracts, rewriteItemRefs } from "./migrate-data-contracts.js";

const HEAD = "apiVersion: flowgraph/v1\nkind: Graph\nmetadata:\n  name: x\n";

describe("migrateDataContracts", () => {
  it("moves channel items and properties into a schema", () => {
    const raw = `${HEAD}state:
  channels:
    tags:
      type: array
      items:
        type: string
    user:
      type: object
      properties:
        name:
          type: string
nodes: []
edges: []
`;
    const r = migrateDataContracts(raw);
    expect(r.changed).toBe(true);
    expect(r.output).toBe(`${HEAD}state:
  channels:
    tags:
      type: array
      schema:
        type: array
        items:
          type: string
    user:
      type: object
      schema:
        type: object
        properties:
          name:
            type: string
nodes: []
edges: []
`);
    const again = migrateDataContracts(r.output);
    expect(again.changed).toBe(false);
    expect(r.notes).toEqual([
      "state.channels.tags: items/properties → schema",
      "state.channels.user: items/properties → schema",
    ]);
  });

  it("keeps an existing schema and reports nothing", () => {
    const raw = `${HEAD}state:\n  channels:\n    a:\n      type: array\n      schema:\n        type: array\n      items:\n        type: string\nnodes: []\nedges: []\n`;
    expect(migrateDataContracts(raw).changed).toBe(false);
  });

  it("moves input field presentation under ui", () => {
    const raw = `${HEAD}inputs:
  - key: topic
    label: Topic
    type: text
  - key: n
    type: number
nodes: []
edges: []
`;
    const r = migrateDataContracts(raw);
    expect(r.output).toContain("ui:");
    expect(r.output).toContain("label: Topic");
    expect(r.output).toContain("widget: textarea");
    expect(r.output).toContain("type: string");
    expect(r.output).not.toContain("type: text");
  });

  it("turns the top-level input into defaults", () => {
    const raw = `${HEAD}inputs:
  - key: topic
input:
  topic: cats
  limit: 3
nodes: []
edges: []
`;
    const r = migrateDataContracts(raw);
    expect(r.output).not.toMatch(/^input:/m);
    expect(r.output).toMatch(/key: topic\n\s+default: cats/);
    expect(r.output).toMatch(/key: limit\n\s+type: number\n\s+default: 3/);
  });

  it("moves with.input to the node input, also in a map body and a nested spec", () => {
    const raw = `${HEAD}nodes:
  - id: a
    type: function
    with:
      fn: f
      input:
        n: "{{ state.n }}"
  - id: m
    type: map
    with:
      over: "{{ state.xs }}"
      node:
        type: shell
        with:
          command: echo
          input:
            v: "{{ item.item }}"
  - id: s
    type: subgraph
    spec:
      nodes:
        - id: inner
          type: script
          with:
            source: x
            input: "{{ state.q }}"
edges: []
`;
    const r = migrateDataContracts(raw);
    expect(r.output).toBe(`${HEAD}nodes:
  - id: a
    type: function
    with:
      fn: f
    input:
      n: "{{ state.n }}"
  - id: m
    type: map
    with:
      over: "{{ state.xs }}"
      node:
        type: shell
        with:
          command: echo
        input:
          v: "{{ item }}"
  - id: s
    type: subgraph
    spec:
      nodes:
        - id: inner
          type: script
          with:
            source: x
          input: "{{ state.q }}"
edges: []
`);
    expect(migrateDataContracts(r.output).changed).toBe(false);
  });

  it("leaves a node with both inputs for a person to merge", () => {
    const raw = `${HEAD}nodes:
  - id: a
    type: function
    input:
      x: 1
    with:
      fn: f
      input:
        y: 2
edges: []
`;
    const r = migrateDataContracts(raw);
    expect(r.changed).toBe(false);
    expect(r.manual).toEqual(["nodes.a: has both input and with.input; merge them into the node's input by hand"]);
  });

  it("reports what has no single rewrite", () => {
    const raw = `${HEAD}nodes:
  - id: m
    type: map
    with:
      over: "{{ state.xs }}"
      output:
        to: x
      node:
        type: function
        with:
          fn: f
  - id: s
    type: subgraph
    with:
      uses: ./c.graph.yaml
      stateMap:
        out:
          a: b
      output:
        to: c
edges: []
`;
    const r = migrateDataContracts(raw);
    expect(r.manual).toEqual([
      "nodes.m: with.output is not supported on a map; use with.collect, or output on the node body",
      "nodes.s: sets both stateMap.out and output; keep one",
    ]);
  });

  it("keeps comments", () => {
    const raw = `${HEAD}inputs:
  # who to greet
  - key: who
    label: Who
nodes: []
edges: []
`;
    expect(migrateDataContracts(raw).output).toContain("# who to greet");
  });

  it("is reached through migrateSpec", () => {
    const r = migrateSpec(`apiVersion: flowgraph/v1\nkind: Graph\nmetadata:\n  name: x\ninputs:\n  - key: a\n    label: A\nnodes: []\nedges: []\n`);
    expect(r.changed).toBe(true);
    expect(r.notes).toEqual(["inputs.a: label → ui.label"]);
    expect(r.manual).toEqual([]);
  });
});

describe("rewriteItemRefs", () => {
  it("rewrites the item read inside templates only", () => {
    expect(rewriteItemRefs("{{ item.item.name }}", "item")).toBe("{{ item.name }}");
    expect(rewriteItemRefs("{{ item.file }} and {{ item['file'] }}", "file")).toBe("{{ file }} and {{ file }}");
    expect(rewriteItemRefs("item.file", "file")).toBe("item.file");
    expect(rewriteItemRefs("{{ state.item.file }}", "file")).toBe("{{ state.item.file }}");
    expect(rewriteItemRefs("{{ item.filename }}", "file")).toBe("{{ item.filename }}");
  });
});
