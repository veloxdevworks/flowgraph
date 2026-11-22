import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { GraphSpecSchema } from "@flowgraph/spec";
import { migrateSpec } from "./migrate.js";

describe("flowgraph migrate", () => {
  it("rewrites pre-v1 aliases (apiVersion, kind, code/intelligent, hook events, runtime.store, kind_of)", () => {
    const legacy = `apiVersion: flowgraph/v0
kind: Subgraph
metadata:
  name: legacy-graph
nodes:
  - id: fn
    type: code
    with:
      fn: transform
  - id: ai
    type: intelligent
    provider: mock
    with:
      prompt: hello
edges:
  - { from: START, to: fn }
  - { from: fn, to: ai }
  - { from: ai, to: END }
runtime:
  hooks:
    - on: intelligent:beforeToolCall
      do: allow
  checkpoint:
    backend: sqlite
  store:
    backend: sqlite
`;

    const first = migrateSpec(legacy);
    expect(first.changed).toBe(true);
    expect(first.output).toContain("apiVersion: flowgraph/v1");
    expect(first.output).toContain("kind: Graph");
    expect(first.output).toContain("type: function");
    expect(first.output).toContain("type: agent");
    expect(first.output).toContain("on: agent:beforeToolCall");
    expect(first.output).toContain("memory:");
    expect(first.output).not.toContain("store:");

    // Also verifies intelligent:afterToolCall rewrite
    const afterHook = migrateSpec("on: intelligent:afterToolCall\n");
    expect(afterHook.changed).toBe(true);
    expect(afterHook.output).toBe("on: agent:afterToolCall\n");

    // The migrated YAML parses cleanly under the current v1 GraphSpecSchema.
    const parsed = GraphSpecSchema.safeParse(parseYaml(first.output));
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);

    // Idempotent: running migrate again produces no changes.
    const second = migrateSpec(first.output);
    expect(second.changed).toBe(false);
    expect(second.output).toBe(first.output);
  });

  it("rewrites inline node types and SKILL.md kind_of to kindOf", () => {
    const inline = `apiVersion: flowgraph/v1
kind: Graph
metadata: { name: inline-legacy }
nodes:
  - { id: a, type: code, with: { fn: f } }
  - { id: b, type: intelligent, provider: mock, with: { prompt: hi } }
edges:
  - { from: START, to: a }
  - { from: a, to: b }
  - { from: b, to: END }
`;
    const migrated = migrateSpec(inline);
    expect(migrated.changed).toBe(true);
    expect(migrated.output).toContain("type: function");
    expect(migrated.output).toContain("type: agent");
    expect(GraphSpecSchema.safeParse(parseYaml(migrated.output)).success).toBe(true);

    const skill = `---
apiVersion: flowgraph/v1
kind: Skill
name: old-skill
version: 0.1.0
kind_of: command
command: ["echo", "hi"]
---
`;
    const migratedSkill = migrateSpec(skill);
    expect(migratedSkill.changed).toBe(true);
    expect(migratedSkill.output).toContain("kindOf: command");
    expect(migratedSkill.output).not.toContain("kind_of:");
  });
});
