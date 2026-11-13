/**
 * Worker side of artifact staging (ADR-0020 section 10): the content store routes, the run-artifact
 * route, and materialization of staged references when a run starts.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { describeArtifactFile, registerFunction } from "@flowgraph/core";
import { createHttpServer } from "./http/app.js";
import { RunService } from "./run-service.js";
import type { Principal, ServerAuthConfig } from "./identity.js";
import type { ServerConfig } from "./types.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

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
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fg-astage-")));
  dirs.push(d);
  return d;
}

async function boot(extra: Partial<ServerConfig> = {}) {
  const graphStoreDir = await tmp();
  const config: ServerConfig = { host: "127.0.0.1", port: 0, graphStoreDir, eventBufferSize: 100, authDisabled: true, ...extra };
  const service = new RunService(config);
  await service.init();
  services.push(service);
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { service, graphStoreDir, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function settle(s: RunService, t: string, want = ["completed", "error", "interrupted"]): Promise<string | undefined> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const st = s.registry.get(t)?.status;
    if (st && want.includes(st)) return st;
    await new Promise((r) => setTimeout(r, 25));
  }
  return s.registry.get(t)?.status;
}

const put = (url: string, body: string | Buffer, headers: Record<string, string> = {}) => fetch(url, { method: "PUT", body, headers });
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// A function that reads its input artifact on the worker, and one that returns whatever record it is given.
registerFunction("asRead", async (input, ctx) => {
  const doc = (input as { doc: { path: string } }).doc;
  return { doc, text: await fs.readFile(path.join(ctx.workspace, doc.path), "utf8") };
});
registerFunction("asProduce", async (input, ctx) => {
  const { name, content } = input as { name: string; content: string };
  const dir = path.join(ctx.workspace, ".flowgraph", "artifacts", "produced");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), content);
  return describeArtifactFile(ctx.workspace, path.join(dir, name));
});
registerFunction("asEcho", (input) => (input as { rec: unknown }).rec);

const fnGraph = (name: string, fn: string, input: string, channels = "made: { type: object }") => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: ${name} }
state:
  channels:
    doc: { type: object }
    ${channels}
nodes:
  - { id: n, type: function, with: { fn: ${fn}, input: ${input}, output: { to: made } } }
edges: [ { from: START, to: n }, { from: n, to: END } ]
`;

describe("PUT / HEAD /worker/artifacts/:sha256", () => {
  it("round-trips a blob into the content store", async () => {
    const { base, graphStoreDir } = await boot();
    const body = Buffer.from("hello artifact");
    const h = sha(body);
    expect((await fetch(`${base}/worker/artifacts/${h}`, { method: "HEAD" })).status).toBe(404);
    const r = await put(`${base}/worker/artifacts/${h}`, body);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ sha256: h, sizeBytes: body.length });
    expect((await fetch(`${base}/worker/artifacts/${h}`, { method: "HEAD" })).status).toBe(200);
    expect(await fs.readFile(path.join(graphStoreDir, ".flowgraph/artifact-store", h), "utf8")).toBe("hello artifact");
  });

  it("refuses a body that does not hash to the address, and leaves nothing behind", async () => {
    const { base, graphStoreDir } = await boot();
    const h = sha("what was promised");
    const r = await put(`${base}/worker/artifacts/${h}`, "something else");
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ code: "ARTIFACT_HASH_MISMATCH" });
    expect((await fetch(`${base}/worker/artifacts/${h}`, { method: "HEAD" })).status).toBe(404);
    expect(await fs.readdir(path.join(graphStoreDir, ".flowgraph/artifact-store"))).toEqual([]);
  });

  it("rejects a malformed address", async () => {
    const { base } = await boot();
    const r = await put(`${base}/worker/artifacts/${"A".repeat(64)}`, "x");
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ code: "ARTIFACT_SHA_INVALID" });
    expect((await fetch(`${base}/worker/artifacts/..%2F..%2Fetc`, { method: "HEAD" })).status).toBe(400);
  });

  it("enforces FLOWGRAPH_ARTIFACT_MAX_BYTES, declared up front and while streaming", async () => {
    const { base, graphStoreDir } = await boot({ artifactMaxBytes: 16 });
    const big = Buffer.alloc(64, "z");
    const declared = await put(`${base}/worker/artifacts/${sha(big)}`, big);
    expect(declared.status).toBe(413);
    expect(await declared.json()).toMatchObject({ code: "ARTIFACT_TOO_LARGE" });

    // no Content-Length: chunked, so only the running count can catch it
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 8; i++) c.enqueue(new Uint8Array(8).fill(122));
        c.close();
      },
    });
    const chunked = await fetch(`${base}/worker/artifacts/${sha(big)}`, { method: "PUT", body: stream, duplex: "half" } as RequestInit);
    expect(chunked.status).toBe(413);
    expect((await fetch(`${base}/worker/artifacts/${sha(big)}`, { method: "HEAD" })).status).toBe(404);
    const store = await fs.readdir(path.join(graphStoreDir, ".flowgraph/artifact-store")).catch(() => []);
    expect(store).toEqual([]);

    const ok = Buffer.alloc(16, "z");
    expect((await put(`${base}/worker/artifacts/${sha(ok)}`, ok)).status).toBe(200);
  });
});

describe("GET /worker/runs/:threadId/artifacts/:sha256", () => {
  async function runToCompletion(base: string, service: RunService, threadId: string, yaml: string, input: Record<string, unknown> = {}) {
    expect((await post(`${base}/runs`, { threadId, yaml, input })).status).toBe(202);
    expect(await settle(service, threadId, ["completed", "error"])).toBe("completed");
  }
  const get = (base: string, threadId: string, h: string) => fetch(`${base}/worker/runs/${encodeURIComponent(threadId)}/artifacts/${h}`);

  it("streams the file of an Artifact record in the thread's state", async () => {
    const { base, service } = await boot();
    const t = `prod/n/1`;
    await runToCompletion(base, service, t, fnGraph("as-prod", "asProduce", "{ name: out.txt, content: made-on-worker }"));
    const h = sha("made-on-worker");
    const r = await get(base, t, h);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe(String("made-on-worker".length));
    expect(await r.text()).toBe("made-on-worker");
    // an Artifact that is not in the state is not served, even if the content exists in the store
    await put(`${base}/worker/artifacts/${sha("other")}`, "other");
    expect((await get(base, t, sha("other"))).status).toBe(404);
    expect((await get(base, "no/such/thread", h)).status).toBe(404);
  });

  it("never serves a path outside the workspace", async () => {
    const { base, service, graphStoreDir } = await boot();
    const outside = path.join(path.dirname(graphStoreDir), `secret-${randomUUID()}.txt`);
    await fs.writeFile(outside, "top secret");
    dirsExtra.push(outside);
    // a record that climbs out, one that is absolute, and one that goes through a symlink
    await fs.mkdir(path.join(graphStoreDir, "links"), { recursive: true });
    await fs.symlink(outside, path.join(graphStoreDir, "links", "leak.txt"));
    const records = (rel: string) => ({ kind: "artifact", path: rel, mimeType: "text/plain", sizeBytes: 10, sha256: sha("top secret") });
    for (const [i, rel] of [`../${path.basename(outside)}`, outside, "links/leak.txt"].entries()) {
      const t = `trav-${i}`;
      await runToCompletion(base, service, t, fnGraph(`as-trav-${i}`, "asEcho", "{ rec: '{{ state.doc }}' }"), { doc: records(rel) });
      const r = await get(base, t, sha("top secret"));
      expect(r.status, rel).toBe(404);
      expect(await r.text()).not.toContain("top secret");
    }
    // control: the same flow serves a file that is inside the workspace
    await fs.writeFile(path.join(graphStoreDir, "inside.txt"), "top secret");
    await runToCompletion(base, service, "trav-ok", fnGraph("as-trav-ok", "asEcho", "{ rec: '{{ state.doc }}' }"), { doc: records("inside.txt") });
    const ok = await get(base, "trav-ok", sha("top secret"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("top secret");
  });
});
const dirsExtra: string[] = [];
afterEach(async () => {
  for (const f of dirsExtra.splice(0)) await fs.rm(f, { force: true });
});

describe("GET of another principal's thread", () => {
  const OIDC: ServerAuthConfig = {
    mode: "oidc",
    explicit: true,
    insecureDev: false,
    oidc: {
      issuer: "https://id.example.com",
      audience: ["api"],
      algorithms: ["RS256"],
      clockToleranceSec: 60,
      claims: { org: "org_id", roles: "roles", teams: "groups", displayName: ["name"] },
      trust: { roles: [], teams: [] },
      defaultProject: "local",
    },
  };
  const who = (subject: string): Principal => ({ id: `https://id.example.com|${subject}`, subject, issuer: "https://id.example.com", org: "acme", project: "web", teams: [], roles: [], trusted: false, via: "oidc" });
  const alice = who("alice");
  const bob = who("bob");
  const gate = (name: string) => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: ${name} }
state:
  channels:
    doc: { type: object }
    approval: { type: object }
nodes:
  - { id: gate, type: hitl, with: { mode: approve, message: "ok?", output: { to: approval } } }
edges: [ { from: START, to: gate }, { from: gate, to: END } ]
`;

  it("is refused for another principal, and blobs are not shared between principals", async () => {
    const dir = await tmp();
    const service = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 100, auth: OIDC });
    await service.init();
    services.push(service);
    const t = `own-${randomUUID()}`;
    await fs.writeFile(path.join(dir, "private.txt"), "alice only");
    const rec = { kind: "artifact", path: "private.txt", mimeType: "text/plain", sizeBytes: 10, sha256: sha("alice only") };
    await service.startRun({ threadId: t, yaml: gate(`g-${randomUUID().slice(0, 8)}`), input: { doc: rec } }, alice);
    expect(await settle(service, t, ["interrupted", "error"])).toBe("interrupted");

    expect((await service.getArtifactFile(t, sha("alice only"), alice)).sizeBytes).toBe(10);
    await expect(service.getArtifactFile(t, sha("alice only"), bob)).rejects.toMatchObject({ status: 403, code: "THREAD_NOT_OWNED" });

    // alice's uploads are invisible to bob
    const { Readable } = await import("node:stream");
    await service.putArtifact(sha("blob"), Readable.from([Buffer.from("blob")]), alice);
    expect(await service.hasArtifact(sha("blob"), alice)).toBe(true);
    expect(await service.hasArtifact(sha("blob"), bob)).toBe(false);
  });
});

describe("staged references when a run starts", () => {
  const staged = (h: string, name: string, extra: object = {}) => ({ kind: "artifact", path: `fg-staged:${h}/${name}`, staged: true, sha256: h, mimeType: "text/plain", sizeBytes: 5, ...extra });

  it("materializes a staged blob as a workspace-relative file a node can read", async () => {
    const { base, service, graphStoreDir } = await boot();
    const h = sha("hello");
    await put(`${base}/worker/artifacts/${h}`, "hello");
    const t = `coord/n/1`;
    expect((await post(`${base}/runs`, { threadId: t, yaml: fnGraph("as-mat", "asRead", "{ doc: '{{ state.doc }}' }"), input: { doc: staged(h, "greeting.txt", { meta: { thumbnail: "x.png", width: 3 } }) } })).status).toBe(202);
    expect(await settle(service, t, ["completed", "error"])).toBe("completed");

    const state = (await (await fetch(`${base}/runs/${encodeURIComponent(t)}/state`)).json()) as { state: { values: { made: { doc: Record<string, unknown>; text: string } } } };
    const { doc, text } = state.state.values.made;
    expect(text).toBe("hello");
    expect(doc["path"]).toBe(`.flowgraph/artifacts/coord_n_1/staged/${h}/greeting.txt`);
    expect(path.isAbsolute(doc["path"] as string)).toBe(false);
    expect(doc["staged"]).toBeUndefined();
    expect(doc["sha256"]).toBe(h);
    expect(doc["meta"]).toEqual({ width: 3 }); // a preview path of the other machine is dropped
    expect(await fs.readFile(path.join(graphStoreDir, doc["path"] as string), "utf8")).toBe("hello");
    // a copy, not a link into the store: editing it cannot damage the blob
    const copy = path.join(graphStoreDir, doc["path"] as string);
    const store = path.join(graphStoreDir, ".flowgraph/artifact-store", h);
    expect((await fs.stat(copy)).ino).not.toBe((await fs.stat(store)).ino);
  });

  it("refuses to start with an unknown sha (ARTIFACT_NOT_STAGED) and does not leave a running thread", async () => {
    const { base, service } = await boot();
    const t = `unk/n/1`;
    const r = await post(`${base}/runs`, { threadId: t, yaml: fnGraph("as-unk", "asRead", "{ doc: '{{ state.doc }}' }"), input: { doc: staged(sha("never uploaded"), "x.txt") } });
    expect(r.status).toBe(422);
    const body = (await r.json()) as { code: string; error: string };
    expect(body.code).toBe("ARTIFACT_NOT_STAGED");
    expect(body.error).toContain(sha("never uploaded"));
    expect(service.registry.get(t)).toBeUndefined();
  });

  it("refuses a malformed reference", async () => {
    const { base } = await boot();
    const h = sha("hello");
    await put(`${base}/worker/artifacts/${h}`, "hello");
    const bad = { ...staged(h, "x.txt"), path: `fg-staged:${h}/../../etc/passwd` };
    const r = await post(`${base}/runs`, { threadId: "mal/n/1", yaml: fnGraph("as-mal", "asRead", "{ doc: '{{ state.doc }}' }"), input: { doc: bad } });
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ code: "ARTIFACT_NOT_STAGED" });
  });
});
