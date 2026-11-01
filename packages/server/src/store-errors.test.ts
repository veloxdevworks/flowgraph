import * as fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphStoreError, INTERNAL_ERROR_BODY } from "./errors.js";
import { parseGraphYaml, persistGraph, updateGraphMeta } from "./graph-source.js";
import { createHttpServer } from "./http/app.js";
import { RunService } from "./run-service.js";
import type { ServerConfig } from "./types.js";

/**
 * A failing file system: when `fault` is set, an fs call it matches throws
 * the error a real disk would, message, path and errno included.
 */
const fault = vi.hoisted(() => ({
  current: null as null | { syscall: "open" | "read"; code: string; when: (file: string) => boolean },
}));
function fsError(syscall: string, code: string, file: string): NodeJS.ErrnoException {
  const text = code === "ENOSPC" ? "no space left on device" : "i/o error";
  return Object.assign(new Error(`${code}: ${text}, ${syscall} '${file}'`), { code, errno: code === "ENOSPC" ? -28 : -5, syscall, path: file });
}
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (file: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
    const f = fault.current;
    if (f?.syscall === "open" && f.when(String(file))) throw fsError("open", f.code, String(file));
    return (actual.open as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.open;
  const readFile = (async (file: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
    const f = fault.current;
    if (f?.syscall === "read" && f.when(String(file))) throw fsError("read", f.code, String(file));
    return (actual.readFile as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.readFile;
  return { ...actual, open, readFile, default: { ...actual, open, readFile } };
});

const YAML = `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: stored }
state:
  channels:
    out: { type: object }
nodes:
  - { id: n, type: function, with: { fn: storeErrorsNoop, output: { to: out } } }
edges:
  - { from: START, to: n }
  - { from: n, to: END }
`;

const dirs: string[] = [];
const servers: Server[] = [];
const services: RunService[] = [];
afterEach(async () => {
  fault.current = null;
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const s of services.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function storeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-store-errors-"));
  dirs.push(dir);
  return dir;
}

/** Serve `service` on a loopback port; returns its base URL. */
async function serve(service: RunService, config: ServerConfig): Promise<string> {
  const server = createHttpServer(service, config);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function realServer(): Promise<{ base: string; dir: string; service: RunService }> {
  const dir = await storeDir();
  const config: ServerConfig = { host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 100, authToken: "t" };
  const service = new RunService(config);
  services.push(service);
  await service.init();
  return { base: await serve(service, config), dir, service };
}

const auth = { authorization: "Bearer t", "content-type": "application/json" };

/** Capture error log lines, parsed. */
function captureErrorLog(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    try {
      lines.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      lines.push({ raw: String(line) });
    }
  });
  return lines;
}

/** No absolute path, errno text or stack trace in what the client got. */
function expectNoDetail(text: string, dir: string): void {
  expect(text).not.toContain(dir);
  expect(text).not.toContain(os.tmpdir());
  expect(text).not.toMatch(/ENOSPC|EIO|errno|syscall/);
  expect(text).not.toMatch(/\n\s+at /);
  expect(text).not.toContain("stack");
}

describe("graph store failures", () => {
  it("a failed write answers 503 GRAPH_STORE_WRITE_FAILED, with the path and errno only in the log", async () => {
    const { base, dir } = await realServer();
    const log = captureErrorLog();
    fault.current = { syscall: "open", code: "ENOSPC", when: (f) => f.startsWith(dir) && f.endsWith(".tmp") };

    const res = await fetch(`${base}/runs`, { method: "POST", headers: auth, body: JSON.stringify({ threadId: "w1", yaml: YAML }) });
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: 'The graph store could not save thread "w1"; try again later', code: "GRAPH_STORE_WRITE_FAILED" });
    expectNoDetail(text, dir);
    const entry = log.find((l) => l["msg"] === "graph store write failed");
    expect(entry).toMatchObject({ threadId: "w1", errno: "ENOSPC", syscall: "open" });
    expect(String(entry?.["path"])).toContain(dir);
  });

  it("a failed graph read answers 503 GRAPH_STORE_READ_FAILED, with the path and errno only in the log", async () => {
    const { base, dir } = await realServer();
    await persistGraph(dir, "r1", YAML, parseGraphYaml(YAML).spec!, { status: "completed" });
    const log = captureErrorLog();
    fault.current = { syscall: "read", code: "EIO", when: (f) => f === path.join(dir, "r1.graph.yaml") };

    const res = await fetch(`${base}/runs/r1`, { headers: auth });
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: 'The graph store could not read thread "r1"; try again later', code: "GRAPH_STORE_READ_FAILED" });
    expectNoDetail(text, dir);
    const entry = log.find((l) => l["msg"] === "graph store read failed");
    expect(entry).toMatchObject({ threadId: "r1", errno: "EIO", syscall: "read", path: path.join(dir, "r1.graph.yaml") });
  });

  it("a missing graph is still not found, not a store failure", async () => {
    const { base } = await realServer();
    const res = await fetch(`${base}/runs/nothing-here`, { headers: auth });
    expect(res.status).toBe(404);
  });

  it("a failed meta update throws GraphStoreError, not the fs error", async () => {
    const dir = await storeDir();
    await persistGraph(dir, "m1", YAML, parseGraphYaml(YAML).spec!, { status: "running" });
    const log = captureErrorLog();
    fault.current = { syscall: "open", code: "ENOSPC", when: (f) => f.endsWith(".tmp") };

    const err = await updateGraphMeta(dir, "m1", { status: "completed" }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GraphStoreError);
    expect(err).toMatchObject({ status: 503, code: "GRAPH_STORE_WRITE_FAILED", cause: expect.objectContaining({ code: "ENOSPC" }) });
    expect((err as Error).message).not.toContain(dir);
    expect(log.find((l) => l["msg"] === "graph store write failed")).toMatchObject({ threadId: "m1", errno: "ENOSPC" });
  });
});

describe("unexpected system errors", () => {
  const dir = "/srv/flowgraph/graphs";
  const sysErr = () => fsError("open", "EIO", `${dir}/secret.graph.yaml`);
  const config: ServerConfig = { host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 100 };
  const authOk = { mode: "token", authenticate: async () => ({ ok: true, principal: { subject: "u", trusted: true } }) };

  it.each([
    ["REST", "/runs", { listRuns: async () => Promise.reject(sysErr()), authenticator: authOk }, "GET"],
    ["AgentCore", "/invocations", { startRun: async () => Promise.reject(sysErr()), authenticator: authOk }, "POST"],
    ["the request handler", "/runs", { authenticator: { mode: "token", authenticate: async () => Promise.reject(sysErr()) } }, "GET"],
  ])("%s answers 500 INTERNAL_ERROR and logs the detail", async (_where, route, stub, method) => {
    const service = { ...stub, config, registry: { hasActiveWork: () => false } } as unknown as RunService;
    const base = await serve(service, config);
    const log = captureErrorLog();

    const res = await fetch(`${base}${route}`, {
      method,
      headers: auth,
      ...(method === "POST" ? { body: JSON.stringify({ action: "start", threadId: "x", yaml: YAML }) } : {}),
    });
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual(INTERNAL_ERROR_BODY);
    expectNoDetail(text, dir);
    expect(log.some((l) => String(l["message"]).includes(`${dir}/secret.graph.yaml`) && typeof l["stack"] === "string")).toBe(true);
  });

  it("a request mistake still answers 400 with its message", async () => {
    const service = {
      config,
      authenticator: authOk,
      listRuns: async () => Promise.reject(new Error("threadId is required")),
    } as unknown as RunService;
    const base = await serve(service, config);
    const res = await fetch(`${base}/runs`, { headers: auth });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "threadId is required" });
  });
});
