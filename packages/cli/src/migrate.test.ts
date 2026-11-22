import { describe, expect, it } from "vitest";
import { parse, parse as parseYaml } from "yaml";
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

  it("applies pre-v1 alias rewrites and data-contract rewrites together in one pass", () => {
    const combined = `apiVersion: flowgraph/v0
kind: Subgraph
metadata:
  name: combined-legacy
inputs:
  - key: topic
    type: text
    label: Topic
input:
  topic: default-topic
state:
  channels:
    tags:
      type: array
      items: { type: string }
nodes:
  - id: fn
    type: code
    with:
      fn: transform
      input:
        topic: "{{ state.topic }}"
  - id: ai
    type: intelligent
    provider: mock
    with:
      prompt: "{{ state.tags }}"
edges:
  - { from: START, to: fn }
  - { from: fn, to: ai }
  - { from: ai, to: END }
runtime:
  checkpoint:
    backend: sqlite
  store:
    backend: sqlite
`;

    const first = migrateSpec(combined);
    expect(first.changed).toBe(true);
    expect(first.manual).toEqual([]);
    expect(first.output).toContain("type: function");
    expect(first.output).toContain("type: agent");
    expect(first.output).toContain("memory:");
    expect(first.output).not.toContain("store:");
    expect(first.output).toContain("widget: textarea");
    expect(first.output).toContain("schema:");
    const parsed = GraphSpecSchema.safeParse(parseYaml(first.output));
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);

    const second = migrateSpec(first.output);
    expect(second.changed).toBe(false);
    expect(second.output).toBe(first.output);
  });

  it("moves agent and router with.provider and with.model to node level and is idempotent", () => {
    const legacy = `apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: provider-move
nodes:
  - id: ask
    type: intelligent
    with:
      provider: anthropic
      model: claude-sonnet-4-6
      prompt: hello
  - id: route
    type: router
    with:
      mode: model
      provider: openai
      model: gpt-4o
      input: "{{ state.text }}"
      routes:
        - name: a
          to: ask
  - id: dup
    type: agent
    provider: mock
    model: m1
    with:
      provider: mock
      model: m1
      prompt: same
  - id: fan
    type: map
    with:
      over: "{{ state.items }}"
      node:
        type: agent
        with:
          provider: mock
          model: fast
          prompt: "{{ item }}"
edges:
  - { from: START, to: route }
  - { from: ask, to: dup }
  - { from: dup, to: fan }
  - { from: fan, to: END }
`;

    const first = migrateSpec(legacy);
    expect(first.changed).toBe(true);
    expect(first.manual).toEqual([]);
    expect(first.notes).toEqual(
      expect.arrayContaining([
        "nodes.ask: with.provider → provider",
        "nodes.ask: with.model → model",
        "nodes.route: with.provider → provider",
        "nodes.route: with.model → model",
        "nodes.dup: removed duplicate with.provider (matches provider)",
        "nodes.dup: removed duplicate with.model (matches model)",
        "nodes.fan.with.node: with.provider → provider",
        "nodes.fan.with.node: with.model → model",
      ]),
    );

    const parsedDoc = parseYaml(first.output) as {
      nodes: Array<{ id: string; provider?: string; model?: string; with?: Record<string, unknown> }>;
    };
    expect(parsedDoc.nodes[0]).toMatchObject({ id: "ask", provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(parsedDoc.nodes[0]?.with).not.toHaveProperty("provider");
    expect(parsedDoc.nodes[0]?.with).not.toHaveProperty("model");
    expect(parsedDoc.nodes[1]).toMatchObject({ id: "route", provider: "openai", model: "gpt-4o" });
    expect(parsedDoc.nodes[1]?.with).not.toHaveProperty("provider");
    expect(parsedDoc.nodes[1]?.with).not.toHaveProperty("model");
    expect(parsedDoc.nodes[2]).toMatchObject({ id: "dup", provider: "mock", model: "m1" });
    expect(parsedDoc.nodes[2]?.with).not.toHaveProperty("provider");
    expect(parsedDoc.nodes[2]?.with).not.toHaveProperty("model");

    const parsed = GraphSpecSchema.safeParse(parsedDoc);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);

    const second = migrateSpec(first.output);
    expect(second.changed).toBe(false);
    expect(second.manual).toEqual([]);
    expect(second.output).toBe(first.output);
  });

  it("reports a manual item when node-level and with provider or model differ", () => {
    const conflicting = `apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: provider-conflict
nodes:
  - id: ask
    type: agent
    provider: anthropic
    model: claude-sonnet-4-6
    with:
      provider: openai
      model: gpt-4o
      prompt: hello
  - id: route
    type: router
    provider: mock
    with:
      mode: model
      provider: openai
      routes:
        - name: a
          to: ask
edges:
  - { from: START, to: route }
  - { from: ask, to: END }
`;

    const first = migrateSpec(conflicting);
    expect(first.changed).toBe(false);
    expect(first.output).toBe(conflicting);
    expect(first.manual).toEqual([
      "nodes.ask: has both provider and with.provider with different values; keep one",
      "nodes.ask: has both model and with.model with different values; keep one",
      "nodes.route: has both provider and with.provider with different values; keep one",
    ]);

    const second = migrateSpec(first.output);
    expect(second.changed).toBe(false);
    expect(second.manual).toEqual(first.manual);
  });

  it("runs webhook, alias, provider/model, and data-contract rewrites together idempotently", () => {
    const legacy = `apiVersion: flowgraph/v0
kind: Subgraph
metadata:
  name: all-migrations
inputs:
  - key: topic
    type: text
    label: Topic
input:
  topic: news
state:
  channels:
    tags:
      type: array
      items: { type: string }
nodes:
  - id: prep
    type: code
    with:
      fn: prepare
      input:
        topic: "{{ state.topic }}"
  - id: ask
    type: intelligent
    with:
      provider: mock
      model: fast
      prompt: "{{ state.tags }}"
  - id: notify
    type: webhook
    with:
      url: https://example.com/hook
      body: { ok: true }
edges:
  - { from: START, to: prep }
  - { from: prep, to: ask }
  - { from: ask, to: notify }
  - { from: notify, to: END }
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
    expect(first.manual).toEqual([]);
    const parsedDoc = parseYaml(first.output) as {
      apiVersion: string;
      kind: string;
      nodes: Array<{ id: string; type: string; provider?: string; model?: string; with?: Record<string, unknown>; input?: unknown }>;
    };
    expect(parsedDoc.apiVersion).toBe("flowgraph/v1");
    expect(parsedDoc.kind).toBe("Graph");
    expect(parsedDoc.nodes[0]).toMatchObject({ id: "prep", type: "function", input: { topic: "{{ state.topic }}" } });
    expect(parsedDoc.nodes[1]).toMatchObject({ id: "ask", type: "agent", provider: "mock", model: "fast" });
    expect(parsedDoc.nodes[1]?.with).not.toHaveProperty("provider");
    expect(parsedDoc.nodes[1]?.with).not.toHaveProperty("model");
    expect(parsedDoc.nodes[2]).toMatchObject({ id: "notify", type: "http", with: { method: "POST", once: true } });

    const validated = GraphSpecSchema.safeParse(parsedDoc);
    expect(validated.success, JSON.stringify(validated.success ? null : validated.error.issues)).toBe(true);

    const second = migrateSpec(first.output);
    expect(second.changed).toBe(false);
    expect(second.manual).toEqual([]);
    expect(second.output).toBe(first.output);
  });
});

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

  it("preserves anchored webhook with: reused at top level, in nested spec, and in map bodies", () => {
    const raw = [
      "apiVersion: flowgraph/v1",
      "kind: Graph",
      "metadata:",
      "  name: anchored-webhook",
      "nodes:",
      "  - id: first_hook",
      "    type: webhook",
      "    with: &w",
      "      url: https://example.com/hook",
      "      headers:",
      "        X-Tag: shared",
      "  - id: plain_http",
      "    type: http",
      "    with: *w",
      "  - id: sub",
      "    type: subgraph",
      "    spec:",
      "      apiVersion: flowgraph/v1",
      "      kind: Graph",
      "      metadata:",
      "        name: child",
      "      nodes:",
      "        - id: child_http",
      "          type: http",
      "          with: *w",
      "      edges:",
      "        - from: START",
      "          to: child_http",
      "        - from: child_http",
      "          to: END",
      "  - id: fanout",
      "    type: map",
      "    with:",
      "      over: \"{{ state.items }}\"",
      "      node:",
      "        id: item_http",
      "        type: http",
      "        with: *w",
      "edges:",
      "  - from: START",
      "    to: first_hook",
      "  - from: first_hook",
      "    to: plain_http",
      "  - from: plain_http",
      "    to: sub",
      "  - from: sub",
      "    to: fanout",
      "  - from: fanout",
      "    to: END",
      "",
    ].join("\n");

    const res = migrateSpec(raw);
    expect(res.changed).toBe(true);
    const parsed = parse(res.output) as {
      nodes: Array<{
        id: string;
        type: string;
        with?: Record<string, unknown>;
        spec?: { nodes: Array<{ id: string; type: string; with: Record<string, unknown> }> };
      }>;
    };

    expect(parsed.nodes[0]).toMatchObject({
      id: "first_hook",
      type: "http",
      with: { url: "https://example.com/hook", headers: { "X-Tag": "shared" }, method: "POST", once: true },
    });
    expect(parsed.nodes[1]?.with).toEqual({ url: "https://example.com/hook", headers: { "X-Tag": "shared" } });
    expect(parsed.nodes[2]?.spec?.nodes[0]?.with).toEqual({ url: "https://example.com/hook", headers: { "X-Tag": "shared" } });
    expect((parsed.nodes[3]?.with?.["node"] as { with: Record<string, unknown> })?.with).toEqual({
      url: "https://example.com/hook",
      headers: { "X-Tag": "shared" },
    });
  });

  it("preserves url on later webhook nodes aliasing an anchored webhook with: &kw", () => {
    const raw = [
      "apiVersion: flowgraph/v1",
      "kind: Graph",
      "metadata:",
      "  name: anchored-webhook-chain",
      "nodes:",
      "  - id: w1",
      "    type: webhook",
      "    with: &kw",
      "      url: https://example.com/hook",
      "  - id: w2",
      "    type: webhook",
      "    with: *kw",
      "edges:",
      "  - from: START",
      "    to: w1",
      "  - from: w1",
      "    to: w2",
      "  - from: w2",
      "    to: END",
      "",
    ].join("\n");

    const res = migrateSpec(raw);
    expect(res.changed).toBe(true);
    const parsed = parse(res.output) as {
      nodes: Array<{ id: string; type: string; with: Record<string, unknown> }>;
    };
    expect(parsed.nodes[0]).toMatchObject({
      id: "w1",
      type: "http",
      with: { url: "https://example.com/hook", method: "POST", once: true },
    });
    expect(parsed.nodes[1]).toMatchObject({
      id: "w2",
      type: "http",
      with: { url: "https://example.com/hook", method: "POST", once: true },
    });
  });

  it("treats << as an ordinary key (matching the loader) and still adds method: POST", () => {
    const raw = [
      "apiVersion: flowgraph/v1",
      "kind: Graph",
      "metadata:",
      "  name: merge-key-hook",
      "x-defaults: &w",
      "  url: https://example.com/hook",
      "  method: PUT",
      "nodes:",
      "  - id: notify",
      "    type: webhook",
      "    with:",
      "      <<: *w",
      "      url: https://example.com/hook",
      "      timeout: 5s",
      "edges:",
      "  - from: START",
      "    to: notify",
      "  - from: notify",
      "    to: END",
      "",
    ].join("\n");

    const res = migrateSpec(raw);
    expect(res.changed).toBe(true);
    const parsed = parse(res.output) as {
      nodes: Array<{ id: string; type: string; with: Record<string, unknown> }>;
    };
    expect(parsed.nodes[0]).toMatchObject({
      id: "notify",
      type: "http",
      with: {
        url: "https://example.com/hook",
        method: "POST",
        timeout: "5s",
        once: true,
      },
    });
  });

  it("throws an error when a webhook with: is an unresolved YAML alias", () => {
    const raw = [
      "apiVersion: flowgraph/v1",
      "kind: Graph",
      "metadata:",
      "  name: bad-alias-hook",
      "nodes:",
      "  - id: notify",
      "    type: webhook",
      "    with: *nope",
      "edges:",
      "  - from: START",
      "    to: notify",
      "  - from: notify",
      "    to: END",
      "",
    ].join("\n");

    expect(() => migrateSpec(raw)).toThrow(/unresolved YAML alias "\*nope"/);
  });

  it("recurses into aliased subgraph spec: *alias", () => {
    const raw = [
      "apiVersion: flowgraph/v1",
      "kind: Graph",
      "metadata:",
      "  name: aliased-spec-hook",
      "x-child: &child_spec",
      "  apiVersion: flowgraph/v1",
      "  kind: Graph",
      "  metadata:",
      "    name: child",
      "  nodes:",
      "    - id: child_hook",
      "      type: webhook",
      "      with:",
      "        url: https://example.com/child",
      "  edges:",
      "    - from: START",
      "      to: child_hook",
      "    - from: child_hook",
      "      to: END",
      "nodes:",
      "  - id: sub",
      "    type: subgraph",
      "    spec: *child_spec",
      "edges:",
      "  - from: START",
      "    to: sub",
      "  - from: sub",
      "    to: END",
      "",
    ].join("\n");

    const res = migrateSpec(raw);
    expect(res.changed).toBe(true);
    const parsed = parse(res.output) as {
      nodes: Array<{
        id: string;
        spec?: { nodes: Array<{ id: string; type: string; with: Record<string, unknown> }> };
      }>;
    };
    expect(parsed.nodes[0]?.spec?.nodes[0]).toMatchObject({
      id: "child_hook",
      type: "http",
      with: { url: "https://example.com/child", method: "POST", once: true },
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
