import { describe, expect, it } from "vitest";
import * as net from "node:net";
import { PortWithSchema, type GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { compileGraph } from "../compiler.js";

function portGraph(withConfig: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "port-graph" },
    state: { channels: { ports: { type: "object" } } },
    nodes: [
      {
        id: "alloc",
        type: "port",
        with: { ...withConfig, output: { to: "ports" } },
      },
    ],
    edges: [
      { from: "START", to: "alloc" },
      { from: "alloc", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false, backend: "memory" } },
  } as unknown as GraphSpec;
}

async function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

describe("PortWithSchema", () => {
  it("accepts defaults and preferred forms", () => {
    expect(PortWithSchema.safeParse({}).success).toBe(true);
    expect(PortWithSchema.safeParse({ count: 2, preferred: 5173 }).success).toBe(true);
    expect(PortWithSchema.safeParse({ preferred: [5173, 4000] }).success).toBe(true);
    expect(PortWithSchema.safeParse({ count: 0 }).success).toBe(false);
  });
});

describe("port node", () => {
  it("allocates a single port and writes port/ports/host", async () => {
    const compiled = await compileGraph(portGraph({}), {});
    const result = await compiled.run({});
    expect(result.status).toBe("completed");
    const out = result.state["ports"] as { port: number; ports: number[]; host: string };
    expect(out.host).toBe("127.0.0.1");
    expect(out.ports).toHaveLength(1);
    expect(out.port).toBe(out.ports[0]);
    expect(out.port).toBeGreaterThan(0);
  });

  it("allocates multiple distinct ports", async () => {
    const compiled = await compileGraph(portGraph({ count: 3 }), {});
    const result = await compiled.run({});
    expect(result.status).toBe("completed");
    const out = result.state["ports"] as { ports: number[] };
    expect(out.ports).toHaveLength(3);
    expect(new Set(out.ports).size).toBe(3);
  });

  it("falls back when preferred is occupied", async () => {
    // Allocate a free port, occupy it, then ask the node to prefer it.
    const probe = await compileGraph(portGraph({}), {});
    const probeResult = await probe.run({});
    const preferred = (probeResult.state["ports"] as { port: number }).port;
    const holder = await occupy(preferred);
    try {
      const compiled = await compileGraph(portGraph({ preferred }), {});
      const result = await compiled.run({});
      expect(result.status).toBe("completed");
      const out = result.state["ports"] as { port: number };
      expect(out.port).not.toBe(preferred);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it("composes with a templated service ready.port", async () => {
    const spec: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "port-service" },
      state: { channels: { ports: { type: "object" } } },
      nodes: [
        {
          id: "alloc",
          type: "port",
          with: { output: { to: "ports" } },
        },
        {
          id: "start",
          type: "service",
          with: {
            name: "echo",
            command: "node",
            args: [
              "-e",
              "const p=Number(process.env.PORT); require('http').createServer((q,s)=>s.end('ok')).listen(p,'127.0.0.1')",
            ],
            env: { PORT: "{{ state.ports.port }}" },
            ready: { port: "{{ state.ports.port }}" },
            readyTimeout: "5s",
            readyInterval: "50ms",
          },
        },
      ],
      edges: [
        { from: "START", to: "alloc" },
        { from: "alloc", to: "start" },
        { from: "start", to: "END" },
      ],
      runtime: { checkpoint: { enabled: false, backend: "memory" } },
    } as unknown as GraphSpec;

    const compiled = await compileGraph(spec, {});
    const result = await compiled.run({ threadId: "port-svc-compose" });
    expect(result.status).toBe("completed");
    const ports = result.state["ports"] as { port: number };
    const svc = (result.state.outputs as Record<string, unknown>)?.["start"] as {
      status: string;
      port: number;
    };
    // Auto-terminated at end, but the node output recorded the allocated port.
    expect(svc.port).toBe(ports.port);
    expect(svc.status).toBe("running");
  });
});
