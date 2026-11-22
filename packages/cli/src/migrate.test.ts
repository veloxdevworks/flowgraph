import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { migrateSpec } from "./migrate.js";

describe("migrateSpec", () => {
  it("rewrites type: webhook to type: http with once: true and default method: POST", () => {
    const raw = [
      "# notify downstream",
      "apiVersion: flowgraph/v1",
      "kind: Graph",
      "metadata:",
      "  name: hook-demo",
      "nodes:",
      "  - id: notify",
      "    type: webhook",
      "    with:",
      "      url: https://example.com/hook",
      "      body:",
      "        event: done",
      "edges:",
      "  - from: START",
      "    to: notify",
      "  - from: notify",
      "    to: END",
      "",
    ].join("\n");

    const res = migrateSpec(raw);
    expect(res.changed).toBe(true);
    expect(res.notes.some((n) => n.includes('type "webhook" → "http"'))).toBe(true);
    expect(res.output).toContain("# notify downstream");

    const parsed = parse(res.output) as {
      nodes: Array<{ id: string; type: string; with: Record<string, unknown> }>;
    };
    expect(parsed.nodes[0]).toMatchObject({
      id: "notify",
      type: "http",
      with: {
        url: "https://example.com/hook",
        method: "POST",
        once: true,
        body: { event: "done" },
      },
    });
  });

  it("preserves explicit method on migrated webhook nodes", () => {
    const raw = [
      "apiVersion: flowgraph/v1",
      "kind: Graph",
      "metadata:",
      "  name: hook-put",
      "nodes:",
      "  - id: notify",
      "    type: webhook",
      "    with:",
      "      url: https://example.com/hook",
      "      method: PUT",
      "edges: []",
      "",
    ].join("\n");

    const res = migrateSpec(raw);
    expect(res.changed).toBe(true);
    const parsed = parse(res.output) as {
      nodes: Array<{ id: string; type: string; with: Record<string, unknown> }>;
    };
    expect(parsed.nodes[0]?.with).toMatchObject({
      url: "https://example.com/hook",
      method: "PUT",
      once: true,
    });
  });

  it("leaves specs without webhook nodes or legacy headers unchanged", () => {
    const raw = "apiVersion: flowgraph/v1\nkind: Graph\nmetadata:\n  name: clean\nnodes: []\nedges: []\n";
    const res = migrateSpec(raw);
    expect(res.changed).toBe(false);
    expect(res.output).toBe(raw);
    expect(res.notes).toEqual([]);
  });
});
