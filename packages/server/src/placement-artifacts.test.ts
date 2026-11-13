/**
 * Artifacts across machines, end to end (ADR-0020 section 10): a coordinator in this process
 * (`compileGraph` + the HTTP transport) places nodes on an in-process worker server, each with its
 * own workspace. A deterministic `function` node reads the input artifact on the worker and writes a new one.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { artifactDir, compileGraph, createHttpTransport, describeArtifactFile, registerFunction } from "@flowgraph/core";
import type { GraphSpec } from "@flowgraph/spec";
import { parseGraphYaml } from "./graph-source.js";
import { createHttpServer } from "./http/app.js";
import { RunService } from "./run-service.js";
import type { ServerConfig } from "./types.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const dirs: string[] = [];
const services: RunService[] = [];
const servers: import("node:http").Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
  for (const s of services.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fg-pa-")));
  dirs.push(d);
  return d;
}

async function worker() {
  const graphStoreDir = await tmp();
  const config: ServerConfig = { host: "127.0.0.1", port: 0, graphStoreDir, eventBufferSize: 500, authDisabled: true, workerLabels: { "app:test": {} } };
  const service = new RunService(config);
  await service.init();
  services.push(service);
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { graphStoreDir, topology: { targets: { worker: { url } } } };
}

function spec(yaml: string): GraphSpec {
  const p = parseGraphYaml(yaml);
  if (!p.spec) throw new Error(JSON.stringify(p.diagnostics));
  return p.spec as GraphSpec;
}

/** Reads the input artifact (on whichever machine runs it), writes an upper-cased copy and returns its record. */
registerFunction("paUpper", async (input, ctx) => {
  const doc = (input as { doc: { path: string } }).doc;
  const text = await fs.readFile(path.join(ctx.workspace, doc.path), "utf8");
  const dir = artifactDir(ctx.workspace, ctx.meta.threadId ?? "run", ctx.nodeId);
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, "upper.txt");
  await fs.writeFile(out, text.toUpperCase());
  await fs.writeFile(path.join(dir, "left-behind.txt"), "never returned");
  return { ran: path.basename(ctx.workspace), file: await describeArtifactFile(ctx.workspace, out) };
});

const LOCAL = ["os:macos"];

const placedSubgraph = spec(`
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: pa-parent }
state:
  channels:
    doc: { type: object }
    result: { type: object }
nodes:
  - id: place
    type: subgraph
    runsOn: [app:test]
    spec:
      apiVersion: flowgraph/v1
      kind: Graph
      metadata: { name: pa-child }
      state:
        channels:
          input: { type: object }
          made: { type: object }
      nodes:
        - { id: up, type: function, with: { fn: paUpper, input: { doc: "{{ state.input }}" }, output: { to: made } } }
      edges: [ { from: START, to: up }, { from: up, to: END } ]
    with:
      stateMap:
        in: { input: doc }
        out: { result: made }
edges: [ { from: START, to: place }, { from: place, to: END } ]
`);

const placedNode = spec(`
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: pa-node }
state:
  channels:
    doc: { type: object }
    made: { type: object }
nodes:
  - id: up
    type: function
    runsOn: [app:test]
    input: { doc: "{{ state.doc }}" }
    with: { fn: paUpper, input: { doc: "{{ input.doc }}" }, output: { to: made } }
edges: [ { from: START, to: up }, { from: up, to: END } ]
`);

/** A transport that counts the HTTP calls it makes. */
function countingTransport() {
  const calls: string[] = [];
  const counted = ((url: unknown, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname.startsWith("/worker/artifacts/") || u.pathname.includes("/artifacts/")) calls.push(`${init?.method ?? "GET"} ${u.pathname.split("/").slice(-2, -1)[0] === "artifacts" ? "run-artifact" : "store"}`);
    return fetch(url as string, init);
  }) as typeof fetch;
  return { calls, transport: createHttpTransport({ fetch: counted, reconnectDelayMs: 5 }) };
}

async function input(coord: string, name: string, text: string) {
  const abs = path.join(coord, "inputs", name);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text);
  return describeArtifactFile(coord, abs);
}

describe("artifacts across a placed subgraph (e2e)", () => {
  it("stages the input in, reads it on the worker, and brings the output back", async () => {
    const { graphStoreDir, topology } = await worker();
    const coord = await tmp();
    const { calls, transport } = countingTransport();
    const compiled = await compileGraph(placedSubgraph, { cwd: coord, placement: { localLabels: LOCAL, topology, transport } });
    const doc = await input(coord, "note.txt", "hello from the coordinator");
    const threadId = `coord-${randomUUID()}`;

    const r = await compiled.run({ threadId, input: { doc } });
    expect(r.status).toBe("completed");

    const result = r.state.result as { ran: string; file: { path: string; sha256: string; sizeBytes: number; kind: string } };
    // the node ran in the worker's workspace, not the coordinator's
    expect(result.ran).toBe(path.basename(graphStoreDir));
    // the returned file is in the coordinator's workspace, workspace-relative, with the right content and hash
    const expectedRel = `.flowgraph/artifacts/${threadId}/place/upper.txt`;
    expect(result.file.path).toBe(expectedRel);
    expect(path.isAbsolute(result.file.path)).toBe(false);
    const bytes = await fs.readFile(path.join(coord, expectedRel), "utf8");
    expect(bytes).toBe("HELLO FROM THE COORDINATOR");
    expect(result.file.sha256).toBe(sha(bytes));
    expect(result.file.sizeBytes).toBe(bytes.length);
    // no worker path leaked into coordinator state
    expect(JSON.stringify(r.state)).not.toContain(graphStoreDir);
    // only what flowed back was fetched
    await expect(fs.stat(path.join(coord, `.flowgraph/artifacts/${threadId}/place/left-behind.txt`))).rejects.toThrow();
    // the worker kept the blob in its content store and its own copy for the run
    const h = doc.sha256!;
    expect(await fs.readFile(path.join(graphStoreDir, ".flowgraph/artifact-store", h), "utf8")).toBe("hello from the coordinator");
    const childKey = `${threadId}/place/1`.replace(/[^A-Za-z0-9._-]+/g, "_");
    expect(await fs.readFile(path.join(graphStoreDir, `.flowgraph/artifacts/${childKey}/staged/${h}/note.txt`), "utf8")).toBe("hello from the coordinator");

    // exactly one upload and one download for this run
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
    expect(calls.filter((c) => c === "GET run-artifact")).toHaveLength(1);
  });

  it("a second run with the same input makes no PUT (the HEAD hits)", async () => {
    const { topology } = await worker();
    const coord = await tmp();
    const { calls, transport } = countingTransport();
    const compiled = await compileGraph(placedSubgraph, { cwd: coord, placement: { localLabels: LOCAL, topology, transport } });
    const doc = await input(coord, "same.txt", "identical input");

    const first = await compiled.run({ threadId: `c1-${randomUUID()}`, input: { doc } });
    expect(first.status).toBe("completed");
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
    calls.length = 0;

    const second = await compiled.run({ threadId: `c2-${randomUUID()}`, input: { doc } });
    expect(second.status).toBe("completed");
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(0);
    expect(calls.filter((c) => c.startsWith("HEAD"))).toHaveLength(1);
    expect((second.state.result as { file: { sha256: string } }).file.sha256).toBe(sha("IDENTICAL INPUT"));
  });

  it("a missing input file fails the node with ARTIFACT_MISSING and nothing reaches the worker", async () => {
    const { graphStoreDir, topology } = await worker();
    const coord = await tmp();
    const { calls, transport } = countingTransport();
    const compiled = await compileGraph(placedSubgraph, { cwd: coord, placement: { localLabels: LOCAL, topology, transport } });
    const doc = await input(coord, "gone.txt", "soon gone");
    await fs.rm(path.join(coord, doc.path));
    const threadId = `miss-${randomUUID()}`;
    const r = await compiled.run({ threadId, input: { doc } });
    expect(r.status).toBe("error");
    expect((r.error as { code?: string }).code).toBe("ARTIFACT_MISSING");
    expect(r.error?.message).toContain("inputs/gone.txt");
    expect(calls).toEqual([]);
    expect(await fs.readdir(graphStoreDir)).not.toContain(`${threadId.replace(/[^A-Za-z0-9._-]/g, "_")}_place_1.graph.yaml`);
  });
});

describe("artifacts across a placed node (e2e)", () => {
  it("stages the node's input in and its output back", async () => {
    const { graphStoreDir, topology } = await worker();
    const coord = await tmp();
    const { calls, transport } = countingTransport();
    const compiled = await compileGraph(placedNode, { cwd: coord, placement: { localLabels: LOCAL, topology, transport } });
    const doc = await input(coord, "node.txt", "wrapped node input");
    const threadId = `node-${randomUUID()}`;
    const r = await compiled.run({ threadId, input: { doc } });
    expect(r.status).toBe("completed");
    const made = r.state.made as { ran: string; file: { path: string } };
    expect(made.ran).toBe(path.basename(graphStoreDir));
    expect(made.file.path).toBe(`.flowgraph/artifacts/${threadId}/up/upper.txt`);
    expect(await fs.readFile(path.join(coord, made.file.path), "utf8")).toBe("WRAPPED NODE INPUT");
    expect((r.state.outputs as { up: { file: { path: string } } }).up.file.path).toBe(made.file.path);
    expect(calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
  });
});
