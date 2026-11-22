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

  it("resolves YAML alias on with: via copy-on-write without dropping url or mutating the anchor", () => {
    const raw = [
      "apiVersion: flowgraph/v1",
      "kind: Graph",
      "metadata:",
      "  name: hook-alias",
      "x-shared: &shared_http",
      "  url: https://example.com/hook",
      "  headers:",
      "    X-Tag: shared",
      "nodes:",
      "  - id: fetch",
      "    type: http",
      "    with: *shared_http",
      "  - id: notify",
      "    type: webhook",
      "    with: *shared_http",
      "edges:",
      "  - from: START",
      "    to: fetch",
      "  - from: fetch",
      "    to: notify",
      "  - from: notify",
      "    to: END",
      "",
    ].join("\n");

    const res = migrateSpec(raw);
    expect(res.changed).toBe(true);
    const parsed = parse(res.output) as {
      "x-shared": Record<string, unknown>;
      nodes: Array<{ id: string; type: string; with: Record<string, unknown> }>;
    };
    // The shared anchor and the plain http node stay untouched (no once/method added).
    expect(parsed["x-shared"]).toEqual({
      url: "https://example.com/hook",
      headers: { "X-Tag": "shared" },
    });
    expect(parsed.nodes[0]).toMatchObject({
      id: "fetch",
      type: "http",
      with: { url: "https://example.com/hook", headers: { "X-Tag": "shared" } },
    });
    expect(parsed.nodes[0]?.with["once"]).toBeUndefined();
    expect(parsed.nodes[0]?.with["method"]).toBeUndefined();

    // The migrated webhook node keeps url + headers and gains method: POST and once: true.
    expect(parsed.nodes[1]).toMatchObject({
      id: "notify",
      type: "http",
      with: {
        url: "https://example.com/hook",
        headers: { "X-Tag": "shared" },
        method: "POST",
        once: true,
      },
    });
  });

  it("recurses into inline subgraph spec: and map body with.node", () => {
    const raw = [
      "apiVersion: flowgraph/v1",
      "kind: Graph",
      "metadata:",
      "  name: nested-hooks",
      "nodes:",
      "  - id: sub",
      "    type: subgraph",
      "    spec:",
      "      apiVersion: flowgraph/v1",
      "      kind: Graph",
      "      metadata:",
      "        name: child",
      "      nodes:",
      "        - id: child-hook",
      "          type: webhook",
      "          with:",
      "            url: https://example.com/child",
      "      edges:",
      "        - from: START",
      "          to: child-hook",
      "        - from: child-hook",
      "          to: END",
      "  - id: fanout",
      "    type: map",
      "    with:",
      "      over: \"{{ state.items }}\"",
      "      node:",
      "        id: item-hook",
      "        type: webhook",
      "        with:",
      "          url: https://example.com/item",
      "edges:",
      "  - from: START",
      "    to: sub",
      "  - from: sub",
      "    to: fanout",
      "  - from: fanout",
      "    to: END",
      "",
    ].join("\n");

    const res = migrateSpec(raw);
    expect(res.changed).toBe(true);
    expect(res.notes).toHaveLength(2);
    const parsed = parse(res.output) as {
      nodes: Array<{
        id: string;
        spec?: { nodes: Array<{ id: string; type: string; with: Record<string, unknown> }> };
        with?: { node?: { id: string; type: string; with: Record<string, unknown> } };
      }>;
    };
    expect(parsed.nodes[0]?.spec?.nodes[0]).toMatchObject({
      id: "child-hook",
      type: "http",
      with: { url: "https://example.com/child", method: "POST", once: true },
    });
    expect(parsed.nodes[1]?.with?.node).toMatchObject({
      id: "item-hook",
      type: "http",
      with: { url: "https://example.com/item", method: "POST", once: true },
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
