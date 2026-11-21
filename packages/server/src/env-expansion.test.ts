import * as fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "./http/app.js";
import { RunService } from "./run-service.js";
import type { ServerConfig, ServerEvent } from "./types.js";

const TOKEN_VALUE = "srv-env-token-value-1234";

const dirs: string[] = [];
const services: RunService[] = [];
const servers: Server[] = [];
beforeEach(() => {
  vi.stubEnv("FG_SRV_ENV_TOKEN", TOKEN_VALUE);
  vi.stubEnv("FG_SRV_ENV_OTHER", "other-env-value-5678");
});
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
  for (const s of services.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function open(extra: Partial<ServerConfig> = {}): Promise<RunService> {
  const graphStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-srv-env-"));
  dirs.push(graphStoreDir);
  const service = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir, eventBufferSize: 200, ...extra });
  await service.init();
  services.push(service);
  return service;
}

/** Every event of the run, once it has ended (replayed from the start of the thread). */
function runEvents(service: RunService, threadId: string): Promise<ServerEvent[]> {
  return new Promise((resolve) => {
    const seen: ServerEvent[] = [];
    let stop: (() => void) | undefined;
    let done = false;
    stop = service.registry.subscribe(threadId, (ev) => {
      seen.push(ev);
      if (!done && (ev.type === "run.end" || ev.type === "run.error")) {
        done = true;
        stop?.();
        resolve(seen);
      }
    }, -1);
    if (done) stop();
  });
}

const ECHO = `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: env-echo }
secrets: [FG_SRV_ENV_TOKEN]
config:
  vars:
    token: "\${FG_SRV_ENV_TOKEN}"
    escaped: "$\${FG_SRV_ENV_OTHER}"
state:
  channels:
    out: { type: object }
nodes:
  - id: echo
    type: script
    with:
      code: "export default async input => input;"
      input:
        token: "{{ config.vars.token }}"
        escaped: "{{ config.vars.escaped }}"
        body: "\${FG_SRV_ENV_TOKEN}"
        other: "\${FG_SRV_ENV_OTHER}"
      output: { to: out }
edges:
  - { from: START, to: echo }
  - { from: echo, to: END }
`;

describe("server ${VAR} expansion for trusted authors", () => {
  it("expands declared config values only, keeps node bodies and $${X} literal, and redacts the value", async () => {
    const service = await open({ trustTokenUploads: true });
    const events = runEvents(service, "t1");
    await service.startRun({ threadId: "t1", yaml: ECHO });
    const all = await events;
    const end = all.find((e) => e.type === "run.end");
    expect(end, JSON.stringify(all.filter((e) => e.type === "run.error"))).toBeDefined();
    expect((end!.data as { state: Record<string, unknown> }).state["out"]).toEqual({
      token: "[REDACTED]",
      escaped: "${FG_SRV_ENV_OTHER}",
      body: "${FG_SRV_ENV_TOKEN}",
      other: "${FG_SRV_ENV_OTHER}",
    });
    const text = JSON.stringify(all);
    expect(text).not.toContain(TOKEN_VALUE);
    expect(text).not.toContain("other-env-value-5678");
    expect(text).not.toContain("$other-env-value");

    const { state } = await service.getState("t1");
    expect(state?.values["out"]).toMatchObject({ token: "[REDACTED]", body: "${FG_SRV_ENV_TOKEN}" });
  });

  it("stores and returns the YAML as uploaded, never the expanded value", async () => {
    const service = await open({ trustTokenUploads: true });
    const events = runEvents(service, "t2");
    await service.startRun({ threadId: "t2", yaml: ECHO });
    await events;
    const stored = await fs.readFile(path.join(service.config.graphStoreDir, "t2.graph.yaml"), "utf-8");
    expect(stored).toBe(ECHO);
    expect(stored).not.toContain(TOKEN_VALUE);
    expect(service.registry.get("t2")?.yaml).toBe(ECHO);
    expect((await service.getRun("t2"))?.yaml).toBe(ECHO);
  });

  it("refuses an undeclared config placeholder with SECRET_UNDECLARED and stores nothing", async () => {
    const service = await open({ trustTokenUploads: true });
    const yaml = ECHO.replace("secrets: [FG_SRV_ENV_TOKEN]\n", "");
    const err = await service.startRun({ threadId: "t3", yaml }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, code: "INVALID_GRAPH" });
    expect((err as { diagnostics: Array<{ code: string; path?: string }> }).diagnostics.filter((d) => d.code === "SECRET_UNDECLARED")).toEqual([
      expect.objectContaining({ code: "SECRET_UNDECLARED", path: "config.vars.token" }),
    ]);
    expect((err as Error).message).not.toContain(TOKEN_VALUE);
    expect(await service.getRun("t3")).toBeNull();
  });
});

const SHELL = `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: token-shell }
state:
  channels:
    out: { type: object }
nodes:
  - { id: n, type: shell, with: { command: "true", output: { to: out } } }
edges:
  - { from: START, to: n }
  - { from: n, to: END }
`;

describe("token-mode uploads", () => {
  async function boot(extra: Partial<ServerConfig>): Promise<{ service: RunService; base: string }> {
    const service = await open({ authToken: "tok", ...extra });
    const server = createHttpServer(service, service.config);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return { service, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }
  const start = (base: string, threadId: string, yaml: string) =>
    fetch(`${base}/runs`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ threadId, yaml }),
    });

  it("refuses a shell node under the shared token by default", async () => {
    const { service, base } = await boot({});
    const res = await start(base, "s1", SHELL);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "UPLOAD_NODE_TYPE_BLOCKED" });
    expect(await service.getRun("s1")).toBeNull();
  });

  it("refuses a ${VAR} placeholder under the shared token by default", async () => {
    const { base } = await boot({});
    const res = await start(base, "s2", ECHO.replace(/  - id: echo[\s\S]*?output: \{ to: out \}\n/, "  - { id: echo, type: wait, with: { duration: 1ms } }\n"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "UPLOAD_ENV_PLACEHOLDER_BLOCKED" });
  });

  it("runs the shell node when the operator trusts token uploads", async () => {
    const { service, base } = await boot({ trustTokenUploads: true });
    const events = runEvents(service, "s3");
    const res = await start(base, "s3", SHELL);
    expect(res.status, await res.clone().text()).toBe(202);
    const all = await events;
    expect(all.map((e) => e.type)).toContain("run.end");
  });
});
