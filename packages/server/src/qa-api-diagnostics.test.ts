import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { RunService } from "./run-service.js";
import { createHttpServer } from "./http/app.js";
import { parseGraphYaml } from "./graph-source.js";
import type { ServerConfig } from "./types.js";
const services: RunService[] = [],
  servers: Server[] = [],
  dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const s of services.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "fg-api-diag-"));
  dirs.push(dir);
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    graphStoreDir: dir,
    eventBufferSize: 50,
    authDisabled: true,
  };
  const service = new RunService(config);
  services.push(service);
  await service.init();
  const server = createHttpServer(service, config);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    service,
    config,
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
}
it.each(["/runs", "/invocations", "/worker/preflight"])(
  "returns a useful 400 for malformed JSON on %s",
  async (endpoint) => {
    const { base } = await boot();
    const res = await fetch(base + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{broken",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_JSON" });
  },
);
it("rejects uploaded imports explicitly before compilation", () => {
  const result = parseGraphYaml(
    JSON.stringify({
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "imports" },
      imports: [{ providers: "./plugin.mjs" }],
      nodes: [{ id: "s", type: "shell", with: { command: "true" } }],
      edges: [
        { from: "START", to: "s" },
        { from: "s", to: "END" },
      ],
    }),
  );
  expect(result.spec).toBeNull();
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "UPLOAD_IMPORTS_BLOCKED" }),
  );
});
it("includes a failed run's message in GET details, including after restart", async () => {
  const { service, config, base } = await boot();
  const yaml = JSON.stringify({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "failure" },
    nodes: [
      {
        id: "fail",
        type: "shell",
        with: {
          command: process.execPath,
          args: ["-e", "process.stderr.write('specific failure');process.exit(2)"],
        },
      },
    ],
    edges: [
      { from: "START", to: "fail" },
      { from: "fail", to: "END" },
    ],
  });
  await service.startRun({ threadId: "failure", yaml });
  await vi.waitFor(() => expect(service.registry.get("failure")?.status).toBe("error"), {
    timeout: 10000,
  });
  expect(
    ((await (await fetch(base + "/runs/failure")).json()) as { error: unknown }).error,
  ).toMatchObject({ message: expect.stringContaining("specific failure") });
  await service.close();
  const cold = new RunService(config);
  services.push(cold);
  await cold.init();
  expect((await cold.getRun("failure"))?.error).toMatchObject({
    message: expect.stringContaining("specific failure"),
  });
});

it("returns a structured import refusal from the real upload endpoint", async () => {
  const { base, service } = await boot();
  const yaml = JSON.stringify({
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "blocked" },
    imports: [{ providers: "./module.mjs" }],
    nodes: [{ id: "s", type: "shell", with: { command: "true" } }],
    edges: [
      { from: "START", to: "s" },
      { from: "s", to: "END" },
    ],
  });
  const response = await fetch(base + "/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: "blocked", yaml }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    code: "UPLOAD_IMPORTS_BLOCKED",
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: "UPLOAD_IMPORTS_BLOCKED" }),
    ]),
  });
  expect(service.registry.get("blocked")).toBeUndefined();
});

it("resumes a paused pre-upgrade thread with stored imports safely removed", async () => {
  const { service, config } = await boot();
  const graph = {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "legacy-resume" },
    state: { channels: { approval: { type: "object" } } },
    nodes: [{
      id: "gate",
      type: "hitl",
      with: { mode: "approve", message: "Continue?", output: { to: "approval" } },
    }],
    edges: [{ from: "START", to: "gate" }, { from: "gate", to: "END" }],
    runtime: { checkpoint: { backend: "memory" } },
  };
  await service.startRun({ threadId: "legacy", yaml: JSON.stringify(graph) });
  await vi.waitFor(() => expect(service.registry.get("legacy")?.status).toBe("interrupted"));
  // Older servers persisted the original upload, including ignored imports.
  await writeFile(join(config.graphStoreDir, "legacy.graph.yaml"), JSON.stringify({
    ...graph,
    imports: [{ providers: "./never-execute.mjs" }],
  }));
  await service.resumeRun({ threadId: "legacy", resume: { approved: true } });
  await vi.waitFor(() => expect(service.registry.get("legacy")?.status).toBe("completed"));
});
