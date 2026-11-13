import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpTransport, registerFunction, resolvePlacements } from "@flowgraph/core";
import type { GraphSpec } from "@flowgraph/spec";
import { createHttpServer } from "./http/app.js";
import { RunService } from "./run-service.js";
import { defaultServerConfig, type ServerConfig } from "./types.js";
import type { Principal, ServerAuthConfig } from "./identity.js";
import { workerLabelsFromEnv } from "./worker-labels.js";

const NODE = process.execPath;
const gate = (name: string) => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: ${name} }
state:
  channels:
    approval: { type: object }
nodes:
  - { id: gate, type: hitl, with: { mode: approve, message: "ok?", output: { to: approval } } }
edges:
  - { from: START, to: gate }
  - { from: gate, to: END }
runtime: { checkpoint: { enabled: true, backend: memory }, hitl: { onInterrupt: fail } }
`;
const shellGraph = (name: string, withBlock: string) => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: ${name} }
state:
  channels:
    out: { type: object }
nodes:
  - { id: n, type: shell, with: { command: "true", ${withBlock} } }
edges:
  - { from: START, to: n }
  - { from: n, to: END }
`;

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
  vi.restoreAllMocks();
});

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "fg-worker-"));
  dirs.push(d);
  return d;
}

async function boot(extra: Partial<ServerConfig> = {}, dir?: string) {
  const graphStoreDir = dir ?? (await tmp());
  const config: ServerConfig = { host: "127.0.0.1", port: 0, graphStoreDir, eventBufferSize: 100, authDisabled: true, ...extra };
  const service = new RunService(config);
  await service.init();
  services.push(service);
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { service, config, graphStoreDir, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function settle(s: RunService, t: string, want: string[]): Promise<string | undefined> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const st = s.registry.get(t)?.status;
    if (st && want.includes(st)) return st;
    await new Promise((r) => setTimeout(r, 25));
  }
  return s.registry.get(t)?.status;
}

describe("THREAD_EXISTS", () => {
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
  const who = (subject: string): Principal => ({
    id: `https://id.example.com|${subject}`,
    subject,
    issuer: "https://id.example.com",
    org: "acme",
    project: "web",
    teams: [],
    roles: [],
    trusted: false,
    via: "oidc",
  });

  it("answers the owner with a structured 409, and the same body over HTTP", async () => {
    const { service, base } = await boot();
    const t = `ex-${randomUUID()}`;
    expect((await post(`${base}/runs`, { threadId: t, yaml: gate("ex-a") })).status).toBe(202);
    expect(await settle(service, t, ["interrupted", "error"])).toBe("interrupted");
    const again = await post(`${base}/runs`, { threadId: t, yaml: gate("ex-a") });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: expect.stringContaining(t),
      code: "THREAD_EXISTS",
      threadId: t,
      status: "interrupted",
      active: false,
    });
  });

  it("reports active: true while the run is executing", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    registerFunction("wpHeld", async () => {
      await held;
      return { n: 1 };
    });
    const { service } = await boot();
    const yaml = `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: held }
state: { channels: { out: { type: object } } }
nodes: [ { id: n, type: function, with: { fn: wpHeld, output: { to: out } } } ]
edges: [ { from: START, to: n }, { from: n, to: END } ]
`;
    await service.startRun({ threadId: "held-1", yaml });
    await expect(service.startRun({ threadId: "held-1", yaml })).rejects.toMatchObject({
      status: 409,
      code: "THREAD_EXISTS",
      extra: { threadId: "held-1", active: true },
    });
    release();
    await settle(service, "held-1", ["completed", "error"]);
  });

  it("does not reveal another principal's thread: bob gets the existing 403", async () => {
    const { service } = await boot({ auth: OIDC, authDisabled: false });
    const alice = who("alice");
    const bob = who("bob");
    await service.startRun({ threadId: "private-1", yaml: gate("alice-g") }, alice);
    expect(await settle(service, "private-1", ["interrupted", "error"])).toBe("interrupted");
    await expect(service.startRun({ threadId: "private-1", yaml: gate("bob-g") }, alice)).rejects.toMatchObject({ status: 409, code: "THREAD_EXISTS" });
    const err = await service.startRun({ threadId: "private-1", yaml: gate("bob-g") }, bob).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403, code: "THREAD_NOT_OWNED" });
    expect((err as { extra?: unknown }).extra).toBeUndefined();
    expect(JSON.stringify({ m: (err as Error).message })).not.toMatch(/interrupted/);
  });
});

describe("worker label config", () => {
  it("reads inline labels and a YAML file (with or without a labels: key)", async () => {
    const dir = await tmp();
    const file = path.join(dir, "labels.yaml");
    await fs.writeFile(file, `labels:\n  app:cc5:\n    check: ["${NODE}", "-e", "0"]\n    every: 5m\n  site:studio: {}\n`);
    expect(workerLabelsFromEnv({ FLOWGRAPH_WORKER_LABELS: "site:a, site:b" })).toEqual({ "site:a": {}, "site:b": {} });
    expect(workerLabelsFromEnv({ FLOWGRAPH_WORKER_LABELS: "site:a", FLOWGRAPH_WORKER_LABELS_FILE: file })).toEqual({
      "site:a": {},
      "app:cc5": { check: [NODE, "-e", "0"], every: "5m" },
      "site:studio": {},
    });
    await fs.writeFile(file, `app:x: { check: [true] }\n`.replace("[true]", `["${NODE}"]`));
    expect(workerLabelsFromEnv({ FLOWGRAPH_WORKER_LABELS_FILE: file })).toEqual({ "app:x": { check: [NODE] } });
    expect(workerLabelsFromEnv({})).toBeUndefined();
  });

  it("fails startup config with a clear message on reserved namespaces, bad labels and bad files", async () => {
    expect(() => defaultServerConfig({ FLOWGRAPH_WORKER_LABELS: "os:windows" } as NodeJS.ProcessEnv)).toThrow(/FLOWGRAPH_WORKER_LABELS.*reserved namespace/);
    expect(() => defaultServerConfig({ FLOWGRAPH_WORKER_LABELS: "nocolon" } as NodeJS.ProcessEnv)).toThrow(/Invalid placement label/);
    const dir = await tmp();
    const file = path.join(dir, "bad.yaml");
    await fs.writeFile(file, `gpu:nvidia: {}\n`);
    expect(() => defaultServerConfig({ FLOWGRAPH_WORKER_LABELS_FILE: file } as NodeJS.ProcessEnv)).toThrow(/FLOWGRAPH_WORKER_LABELS_FILE.*reserved/);
    await fs.writeFile(file, `app:y: { chek: [a] }\n`);
    expect(() => defaultServerConfig({ FLOWGRAPH_WORKER_LABELS_FILE: file } as NodeJS.ProcessEnv)).toThrow(/FLOWGRAPH_WORKER_LABELS_FILE/);
    expect(() => defaultServerConfig({ FLOWGRAPH_WORKER_LABELS_FILE: path.join(dir, "missing.yaml") } as NodeJS.ProcessEnv)).toThrow(/cannot read/);
  });
});

describe("GET /worker/labels", () => {
  const labels = {
    "site:trusted": {},
    "app:test": { check: [NODE, "-e", "process.exit(0)"] },
    "app:broken": { check: [NODE, "-e", "process.exit(3)"] },
  };

  it("advertises built-ins, trusted and passing labels; withdraws failing ones with the reason", async () => {
    const { base } = await boot({ workerLabels: labels });
    const res = await fetch(`${base}/worker/labels`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { labels: string[]; checks: Record<string, { ok: boolean; error?: string; checkedAt: string }>; flowgraphVersion: string };
    expect(body.labels).toEqual(expect.arrayContaining(["site:trusted", "app:test", "nodeType:shell"]));
    expect(body.labels).not.toContain("app:broken");
    expect(body.labels.some((l) => l.startsWith("os:"))).toBe(true);
    expect(body.checks["app:test"]).toMatchObject({ ok: true });
    expect(body.checks["app:broken"]).toMatchObject({ ok: false, error: expect.stringMatching(/exited 3/) });
    expect(body.flowgraphVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("needs the same auth as other REST routes", async () => {
    const { base } = await boot({ authDisabled: false, authToken: "s3cret" });
    expect((await fetch(`${base}/worker/labels`)).status).toBe(401);
    expect((await post(`${base}/worker/preflight`, { yaml: gate("x") })).status).toBe(401);
    expect((await fetch(`${base}/worker/labels`, { headers: { authorization: "Bearer s3cret" } })).status).toBe(200);
  });

  it("re-checks on the interval, unref's its timers, and stops them on close", async () => {
    const dir = await tmp();
    const log = path.join(dir, "ticks.log");
    const intervals: NodeJS.Timeout[] = [];
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((...a: Parameters<typeof setInterval>) => {
      const t = real(...a);
      intervals.push(t);
      return t;
    }) as typeof setInterval);
    const { service } = await boot({
      workerLabels: {
        "app:tick": { check: [NODE, "-e", `require("fs").appendFileSync(${JSON.stringify(log)}, "x\\n")`], every: "50ms" },
        "site:plain": {},
      },
    });
    expect(service.workerLabels.timerCount).toBe(1); // only the checked label is scheduled
    expect(intervals.some((t) => t.hasRef() === false)).toBe(true);
    const lines = async () => (await fs.readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    const end = Date.now() + 10_000;
    while ((await lines()) < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(await lines()).toBeGreaterThanOrEqual(3); // startup check plus at least two re-checks
    await service.close();
    expect(service.workerLabels.timerCount).toBe(0);
    await new Promise((r) => setTimeout(r, 200)); // let an in-flight check finish
    const after = await lines();
    await new Promise((r) => setTimeout(r, 300));
    expect(await lines()).toBe(after);
  });

  it("picks up a label whose check starts failing", async () => {
    const dir = await tmp();
    const flag = path.join(dir, "present");
    await fs.writeFile(flag, "");
    const { service } = await boot({
      workerLabels: { "app:flaky": { check: [NODE, "-e", `require("fs").accessSync(${JSON.stringify(flag)})`], every: "50ms" } },
    });
    expect((await service.workerLabels.snapshot()).labels).toContain("app:flaky");
    await fs.rm(flag);
    const end = Date.now() + 10_000;
    while ((await service.workerLabels.snapshot()).labels.includes("app:flaky") && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    const snap = await service.workerLabels.snapshot();
    expect(snap.labels).not.toContain("app:flaky");
    expect(snap.checks["app:flaky"]?.ok).toBe(false);
  });
});

describe("POST /worker/preflight", () => {
  const files = async (dir: string) => (await fs.readdir(dir)).sort();

  it("accepts a good graph (yaml or spec) and creates nothing", async () => {
    const { base, graphStoreDir, service } = await boot();
    const res = await post(`${base}/worker/preflight`, { yaml: shellGraph("pf-ok", "") });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, diagnostics: expect.any(Array) });
    const spec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "pf-spec" },
      state: { channels: { out: { type: "object" } } },
      nodes: [{ id: "n", type: "shell", with: { command: "true" } }],
      edges: [{ from: "START", to: "n" }, { from: "n", to: "END" }],
    };
    expect(await (await post(`${base}/worker/preflight`, { spec })).json()).toMatchObject({ ok: true });
    expect(await files(graphStoreDir)).toEqual([]);
    expect(service.registry.list()).toEqual([]);
    expect(await (await fetch(`${base}/runs`)).json()).toEqual({ runs: [] });
  });

  it("reports a missing binary, an unknown node type, bad input and UNKNOWN_FIELD as not ok", async () => {
    const { base, graphStoreDir, service } = await boot();
    const run = async (body: unknown) => (await (await post(`${base}/worker/preflight`, body)).json()) as { ok: boolean; diagnostics: Array<{ code: string; severity: string }> };

    const missing = await run({ yaml: shellGraph("pf-bin", `requires: [{ bin: definitely-not-installed-bin-xyz }]`) });
    expect(missing.ok).toBe(false);
    expect(missing.diagnostics.map((d) => d.code)).toContain("BIN_NOT_FOUND");

    const optional = await run({ yaml: shellGraph("pf-opt", `requires: [{ bin: definitely-not-installed-bin-xyz }], onMissingTool: skip`) });
    expect(optional.ok).toBe(true);
    expect(optional.diagnostics.map((d) => d.code)).toContain("BIN_NOT_FOUND_OPTIONAL");

    const unknown = await run({ yaml: shellGraph("pf-type", "").replace("type: shell", "type: nosuchnode") });
    expect(unknown.ok).toBe(false);
    expect(unknown.diagnostics.map((d) => d.code)).toContain("UNKNOWN_NODE_TYPE");

    const extra = await run({ yaml: shellGraph("pf-field", "").replace("{ id: n,", "{ id: n, runsOnn: [os:linux],") });
    expect(extra.ok).toBe(false);
    expect(extra.diagnostics.map((d) => d.code)).toContain("UNKNOWN_FIELD");

    const input = await run({
      yaml: shellGraph("pf-input", "").replace("state:", "inputs:\n  - { key: topic, type: string, required: true }\nstate:"),
      input: {},
    });
    expect(input.ok).toBe(false);
    expect(input.diagnostics.map((d) => d.code)).toContain("INPUT_INVALID");

    expect((await post(`${base}/worker/preflight`, {})).status).toBe(400);
    expect(await files(graphStoreDir)).toEqual([]);
    expect(service.registry.list()).toEqual([]);
  });

  it("applies the upload policy and reports stripped imports", async () => {
    const { base } = await boot();
    const withImports = `imports:\n  nodes: ["./evil.js"]\n${shellGraph("pf-imp", "")}`;
    const body = (await (await post(`${base}/worker/preflight`, { yaml: withImports })).json()) as { ok: boolean; importsStripped?: boolean };
    expect(body).toMatchObject({ ok: true, importsStripped: true });
  });

  it("refuses untrusted graphs the run path would refuse", async () => {
    const { service } = await boot({ authDisabled: false, authToken: "t" });
    const untrusted = { ...service.principalFor(), trusted: false };
    const yaml = shellGraph("pf-untrusted", "");
    await expect(service.preflight({ yaml }, untrusted)).rejects.toMatchObject({ status: 403 });
    await expect(service.startRun({ threadId: "u1", yaml }, untrusted)).rejects.toMatchObject({ status: 403 });
  });
});

describe("placement end to end over the direct transport", () => {
  const specFor = (labels: string[]): GraphSpec =>
    ({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "placed" },
      state: { channels: { out: { type: "object" } } },
      nodes: [{ id: "char", type: "shell", runsOn: labels, with: { command: "true" } }],
      edges: [{ from: "START", to: "char" }, { from: "char", to: "END" }],
    }) as unknown as GraphSpec;

  async function resolve(workerLabels: NonNullable<ServerConfig["workerLabels"]>, spec: GraphSpec) {
    const { base } = await boot({ authDisabled: false, authToken: "tok", workerLabels });
    return resolvePlacements(spec, {
      localLabels: ["os:macos"],
      topology: { targets: { studio: { url: base, token: "tok" } } },
      transport: createHttpTransport(),
    });
  }

  it("picks the worker when it advertises app:test", async () => {
    const { decisions, diagnostics } = await resolve({ "app:test": { check: [NODE, "-e", "0"] } }, specFor(["app:test"]));
    expect(diagnostics).toEqual([]);
    expect(decisions[0]).toMatchObject({ kind: "remote", target: "studio" });
  });

  it("is unsatisfied when the check fails, naming the withdrawn label", async () => {
    const { decisions, diagnostics } = await resolve({ "app:test": { check: [NODE, "-e", "process.exit(1)"] } }, specFor(["app:test"]));
    expect(decisions[0]).toMatchObject({ kind: "unsatisfied" });
    expect(diagnostics[0]).toMatchObject({ code: "PLACEMENT_UNSATISFIED" });
    expect(diagnostics[0]!.message).toMatch(/app:test/);
    expect(diagnostics[0]!.message).toMatch(/exited 1/);
  });

  it("fails worker preflight (not label match) when the worker lacks a required binary", async () => {
    const spec = specFor(["app:test"]);
    (spec.nodes[0] as { with: unknown }).with = { command: "true", requires: [{ bin: "definitely-not-installed-bin-xyz" }] };
    const { decisions } = await resolve({ "app:test": {} }, spec);
    expect(decisions[0]!.kind).toBe("unsatisfied");
    expect(decisions[0]!.candidates.find((c) => c.target === "studio")).toMatchObject({ status: "preflight-failed" });
  });

  it("reports a wrong token as unreachable", async () => {
    const { base } = await boot({ authDisabled: false, authToken: "tok", workerLabels: { "app:test": {} } });
    const { decisions } = await resolvePlacements(specFor(["app:test"]), {
      localLabels: [],
      topology: { targets: { studio: { url: base, token: "nope" } } },
      transport: createHttpTransport(),
    });
    expect(decisions[0]!.candidates.find((c) => c.target === "studio")).toMatchObject({ status: "unreachable", detail: expect.stringMatching(/401/) });
  });
});
