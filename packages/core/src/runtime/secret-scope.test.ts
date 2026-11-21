import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph } from "../compiler.js";

function headerGraph(headers: Record<string, string>, secrets: string[] = ["FGQA_SCOPE_DECOY", "FGQA_SCOPE_UNSET"]): GraphSpec {
  return {
    metadata: { name: "secret-scope" },
    secrets,
    nodes: [{ id: "call", type: "http", with: { url: "http://127.0.0.1:9/x", headers } }],
    edges: [
      { from: "START", to: "call" },
      { from: "call", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

async function sentHeaders(headers: Record<string, string>): Promise<unknown> {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
  const result = await (await compileGraph(headerGraph(headers))).run();
  expect(result.status).toBe("completed");
  return fetchMock.mock.calls[0]?.[1]?.headers;
}

describe("secret template scope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("renders a set secret in sole and interpolated templates", async () => {
    vi.stubEnv("FGQA_SCOPE_DECOY", "decoy-scope-value");
    expect(
      await sentHeaders({
        A: "{{ secret.FGQA_SCOPE_DECOY }}",
        B: "t {{ secret.FGQA_SCOPE_DECOY }}",
      }),
    ).toMatchObject({ A: "decoy-scope-value", B: "t decoy-scope-value" });
  });

  it("renders an unset secret as an empty string, never null", async () => {
    expect(
      await sentHeaders({
        A: "{{ secret.FGQA_SCOPE_UNSET }}",
        B: "t {{ secret.FGQA_SCOPE_UNSET }}",
      }),
    ).toMatchObject({ A: "", B: "t " });
  });

  it("refuses a literal name the graph does not declare when it compiles", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(compileGraph(headerGraph({ A: "{{ secret.FGQA_SCOPE_DECOY }}" }, []))).rejects.toThrow(
      'nodes.call.with.headers.A: Node "call" reads secret "FGQA_SCOPE_DECOY", which the graph does not declare. Add FGQA_SCOPE_DECOY to the top-level secrets: list.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails the node on a computed name the graph does not declare", async () => {
    vi.stubEnv("FGQA_SCOPE_DECOY", "decoy-scope-value");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const spec = headerGraph({ A: "{{ secret[config.vars.key] }}" }, []);
    spec.config = { vars: { key: "FGQA_SCOPE_DECOY" } };
    const result = await (await compileGraph(spec)).run();
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain(
      'http node "call" reads secret "FGQA_SCOPE_DECOY", which the graph does not declare. Add FGQA_SCOPE_DECOY to the top-level secrets: list.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "treats %s as an ordinary undeclared name, not an object member",
    async (name) => {
      const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
      vi.stubGlobal("fetch", fetchMock);
      await expect(compileGraph(headerGraph({ A: `{{ secret.${name} }}` }, []))).rejects.toThrow(
        `reads secret "${name}", which the graph does not declare`,
      );
      const spec = headerGraph({ A: "{{ secret[config.vars.key] }}" }, []);
      spec.config = { vars: { key: name } };
      const result = await (await compileGraph(spec)).run();
      expect(result.status).toBe("error");
      expect(result.error?.message).toContain(`reads secret "${name}", which the graph does not declare`);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["__proto__", "constructor"])("renders a declared %s from the host, or empty when unset", async (name) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const spec = headerGraph({ A: "{{ secret[config.vars.key] }}", B: `t {{ secret["${name}"] }}` }, [name]);
    spec.config = { vars: { key: name } };
    const result = await (await compileGraph(spec)).run();
    expect(result.status).toBe("completed");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ A: "", B: "t " });
  });

  describe("subgraphs", () => {
    const parentOf = (node: Record<string, unknown>, secrets: string[]) =>
      ({
        metadata: { name: "secret-parent" },
        secrets,
        nodes: [{ id: "sub", type: "subgraph", ...node }],
        edges: [
          { from: "START", to: "sub" },
          { from: "sub", to: "END" },
        ],
        runtime: { checkpoint: { enabled: false } },
      }) as unknown as GraphSpec;

    it("refuses an inline child reading what only its parent declares", async () => {
      const child = headerGraph({ A: "{{ secret.FGQA_SCOPE_DECOY }}" }, []);
      await expect(compileGraph(parentOf({ spec: child }, ["FGQA_SCOPE_DECOY"]))).rejects.toThrow(
        'nodes.sub.spec.nodes.call.with.headers.A: Node "call" reads secret "FGQA_SCOPE_DECOY", which the graph does not declare',
      );
    });

    it("checks a computed name in an inline child against the child's list", async () => {
      vi.stubEnv("FGQA_SCOPE_DECOY", "decoy-scope-value");
      const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
      vi.stubGlobal("fetch", fetchMock);
      const child = headerGraph({ A: "{{ secret[config.vars.key] }}" }, []);
      child.config = { vars: { key: "FGQA_SCOPE_DECOY" } };
      const result = await (await compileGraph(parentOf({ spec: child }, ["FGQA_SCOPE_DECOY"]))).run();
      expect(result.status).toBe("error");
      expect(result.error?.message).toContain('reads secret "FGQA_SCOPE_DECOY", which the graph does not declare');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    describe("file subgraphs", () => {
      let dir = "";
      beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-secret-file-"));
      });
      afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

      const writeChild = (secrets: string[]) =>
        fs.writeFileSync(
          path.join(dir, "child.graph.yaml"),
          [
            "apiVersion: flowgraph/v1",
            "kind: Graph",
            "metadata: { name: child }",
            `secrets: ${JSON.stringify(secrets)}`,
            "nodes:",
            '  - { id: call, type: http, with: { url: "http://127.0.0.1:9/x", headers: { A: "{{ secret.FGQA_SCOPE_DECOY }}" } } }',
            "edges: [{ from: START, to: call }, { from: call, to: END }]",
            "",
          ].join("\n"),
        );

      it("reads a name the child file declares", async () => {
        vi.stubEnv("FGQA_SCOPE_DECOY", "decoy-scope-value");
        const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
        vi.stubGlobal("fetch", fetchMock);
        writeChild(["FGQA_SCOPE_DECOY"]);
        const result = await (await compileGraph(parentOf({ uses: "./child.graph.yaml" }, []), { cwd: dir })).run();
        expect(result.status).toBe("completed");
        expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ A: "decoy-scope-value" });
      });

      it("refuses a name only the parent declares", async () => {
        vi.stubEnv("FGQA_SCOPE_DECOY", "decoy-scope-value");
        const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
        vi.stubGlobal("fetch", fetchMock);
        writeChild([]);
        const result = await (
          await compileGraph(parentOf({ uses: "./child.graph.yaml" }, ["FGQA_SCOPE_DECOY"]), { cwd: dir })
        ).run();
        expect(result.status).toBe("error");
        expect(result.error?.message).toContain('reads secret "FGQA_SCOPE_DECOY", which the graph does not declare');
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });
  });
});
