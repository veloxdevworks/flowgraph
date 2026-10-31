import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { RunService } from "./run-service.js";
import type { Principal, ServerAuthConfig } from "./identity.js";
import type { ServerConfig } from "./types.js";

const PG_URL = process.env["FLOWGRAPH_TEST_POSTGRES_URL"];

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
const alice = who("alice");

const gate = (name: string, extra = "") => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: ${name} }
${extra}
state:
  channels:
    secret: { type: string }
    approval: { type: object }
nodes:
  - { id: gate, type: hitl, with: { mode: approve, message: "ok?", output: { to: approval } } }
edges:
  - { from: START, to: gate }
  - { from: gate, to: END }
`;

const reviewGraph = (diff: string) => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: review-diff }
state:
  channels:
    d: { type: object }
nodes:
  - id: r
    type: hitl
    with:
      mode: review
      message: "look"
      diff: ${diff}
      output: { to: d }
edges:
  - { from: START, to: r }
  - { from: r, to: END }
`;

const services: RunService[] = [];
const dirs: string[] = [];
const markers: string[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  for (const m of markers.splice(0)) fss.rmSync(m, { force: true });
});

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "fg-host-exec-"));
  dirs.push(d);
  return d;
}

async function service(extra: Partial<ServerConfig>): Promise<RunService> {
  const s = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: await tmp(), eventBufferSize: 100, auth: OIDC, ...extra });
  await s.init();
  services.push(s);
  return s;
}

async function settle(s: RunService, threadId: string, want: string[]): Promise<string | undefined> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const st = s.registry.get(threadId)?.status;
    if (st && want.includes(st)) return st;
    await new Promise((r) => setTimeout(r, 25));
  }
  return s.registry.get(threadId)?.status;
}

const codeOf = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "OK",
    (e: { status?: number; code?: string; message?: string }) => `${e.status ?? 403} ${e.code ?? e.message}`,
  );

const backends: Array<[string, Partial<ServerConfig>]> = [["memory", {}]];
if (PG_URL) backends.push(["postgres", { databaseUrl: PG_URL }]);

describe.each(backends)("untrusted uploads cannot start host programs (%s)", (_name, extra) => {
  it("refuses __services in run input and never starts the planted command", async () => {
    const s = await service(extra);
    const marker = path.join(os.tmpdir(), `fg-host-exec-${randomUUID()}`);
    markers.push(marker);
    const planted = { pwn: { name: "pwn", command: "sh", args: ["-c", `id > ${marker}`], keepAlive: true } };
    const t = `svc-${randomUUID()}`;
    const start = await codeOf(s.startRun({ threadId: t, yaml: gate("svc-plain"), input: { secret: "x", __services: planted } }, alice));
    expect(start).toBe("403 RESERVED_CHANNEL_BLOCKED");
    for (const key of ["__worktrees", "__agentReplay", "__interrupt__"]) {
      expect(await codeOf(s.startRun({ threadId: `${t}-${key}`, yaml: gate("svc-plain"), input: { [key]: {} } }, alice))).toBe("403 RESERVED_CHANNEL_BLOCKED");
    }
    // The graph from the report, with rehydrateOnResume, is refused at upload.
    const rehydrate = gate("svc-hydrate", "runtime:\n  services:\n    rehydrateOnResume: true\n    terminateOnEnd: false");
    expect(await codeOf(s.startRun({ threadId: `${t}-r`, yaml: rehydrate, input: { secret: "x" } }, alice))).toBe("403 UPLOAD_RUNTIME_HOST_EXEC_BLOCKED");
    const cleanup = gate("wt-cleanup", "runtime:\n  worktrees:\n    cleanupOnEnd: true");
    expect(await codeOf(s.startRun({ threadId: `${t}-w`, yaml: cleanup, input: {} }, alice))).toBe("403 UPLOAD_RUNTIME_HOST_EXEC_BLOCKED");

    // A normal run on the same service still works end to end.
    await s.startRun({ threadId: t, yaml: gate("svc-plain"), input: { secret: "x" } }, alice);
    expect(await settle(s, t, ["interrupted", "error"])).toBe("interrupted");
    await s.resumeRun({ threadId: t, resume: { approved: true } }, alice);
    expect(await settle(s, t, ["completed", "error"])).toBe("completed");
    await new Promise((r) => setTimeout(r, 300));
    expect(fss.existsSync(marker)).toBe(false);
  });

  it("refuses graphs that write or declare reserved channels", async () => {
    const s = await service(extra);
    const writes = gate("writes-reserved")
      .replace("output: { to: approval }", "output: { to: __services }")
      .replace("    approval: { type: object }", "    __services: { type: object }");
    expect(await codeOf(s.startRun({ threadId: `wr-${randomUUID()}`, yaml: writes, input: {} }, alice))).toBe("403 UPLOAD_RESERVED_CHANNEL_BLOCKED");
    const declares = gate("declares-reserved").replace("    secret: { type: string }", "    __worktrees: { type: array }");
    expect(await codeOf(s.startRun({ threadId: `dc-${randomUUID()}`, yaml: declares, input: {} }, alice))).toBe("403 UPLOAD_RESERVED_CHANNEL_BLOCKED");
    const defaults = gate("default-reserved", "input:\n  __services: {}");
    expect(await codeOf(s.startRun({ threadId: `df-${randomUUID()}`, yaml: defaults, input: {} }, alice))).toBe("403 UPLOAD_RESERVED_CHANNEL_BLOCKED");
  });

  it("refuses a review-mode git diff on a host repo, and leaks nothing into state", async () => {
    const s = await service(extra);
    const repo = path.resolve(process.cwd(), "../..");
    const diff = `{ cwd: "${repo}", base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", paths: ["packages/server/src/types.ts"] }`;
    const t = `rv-${randomUUID()}`;
    expect(await codeOf(s.startRun({ threadId: t, yaml: reviewGraph(diff), input: {} }, alice))).toBe("403 UPLOAD_HOST_PATH_BLOCKED");
    expect(s.registry.get(t)).toBeUndefined();
    // Inline before/after text is still fine.
    const inline = `{ before: "a", after: "b" }`;
    const t2 = `rv-${randomUUID()}`;
    await s.startRun({ threadId: t2, yaml: reviewGraph(inline), input: {} }, alice);
    expect(await settle(s, t2, ["interrupted", "error"])).toBe("interrupted");
    const state = JSON.stringify(await s.getState(t2, reviewGraph(inline), alice));
    expect(state).not.toContain("ServerMemoryConfig");
  });
});
