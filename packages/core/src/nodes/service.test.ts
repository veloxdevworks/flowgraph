import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { ServiceWithSchema, type GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { compileGraph } from "../compiler.js";
import {
  listThreadServices,
  resetServiceManager,
  statusService,
} from "../runtime/service-manager.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("no port"));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function serviceGraph(opts: {
  nodes: GraphSpec["nodes"];
  terminateOnEnd?: boolean;
  checkpoint?: boolean;
}): GraphSpec {
  const edges = [
    { from: "START", to: opts.nodes[0]!.id },
    ...opts.nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: opts.nodes[i + 1]!.id })),
    { from: opts.nodes[opts.nodes.length - 1]!.id, to: "END" },
  ];
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "service-graph" },
    nodes: opts.nodes,
    edges,
    runtime: {
      checkpoint: {
        enabled: opts.checkpoint ?? false,
        backend: "memory",
      },
      services: {
        terminateOnEnd: opts.terminateOnEnd ?? true,
      },
    },
  } as unknown as GraphSpec;
}

afterEach(async () => {
  await resetServiceManager();
});

describe("ServiceWithSchema", () => {
  it("requires command for start/restart", () => {
    expect(ServiceWithSchema.safeParse({ name: "x" }).success).toBe(false);
    expect(ServiceWithSchema.safeParse({ name: "x", command: "node" }).success).toBe(true);
    expect(
      ServiceWithSchema.safeParse({ name: "x", action: "stop" }).success,
    ).toBe(true);
    expect(
      ServiceWithSchema.safeParse({ name: "x", action: "restart" }).success,
    ).toBe(false);
  });
});

describe("service node", () => {
  it("starts a service and writes output", async () => {
    const port = await freePort();
    const compiled = await compileGraph(
      serviceGraph({
        nodes: [
          {
            id: "start-svc",
            type: "service",
            with: {
              name: "api",
              command: "node",
              args: [
                "-e",
                `require('http').createServer((q,s)=>s.end('ok')).listen(${port}, '127.0.0.1')`,
              ],
              ready: { port },
              readyTimeout: "5s",
              readyInterval: "50ms",
            },
          },
        ],
      }),
      {},
    );

    const result = await compiled.run({ threadId: "svc-run-1" });
    expect(result.status).toBe("completed");
    const out = (result.state.outputs as Record<string, unknown>)?.["start-svc"] as {
      status: string;
      port: number;
      name: string;
    };
    expect(out.name).toBe("api");
    expect(out.status).toBe("running");
    expect(out.port).toBe(port);
    // Auto-terminated at run end
    expect(statusService("svc-run-1", "api").status).toBe("not_found");
  });

  it("status and stop actions work mid-graph", async () => {
    const compiled = await compileGraph(
      serviceGraph({
        nodes: [
          {
            id: "start",
            type: "service",
            with: {
              name: "bg",
              command: "node",
              args: ["-e", "setInterval(() => {}, 1000)"],
            },
          },
          {
            id: "check",
            type: "service",
            with: { name: "bg", action: "status" },
          },
          {
            id: "halt",
            type: "service",
            with: { name: "bg", action: "stop" },
          },
        ],
      }),
      {},
    );

    const result = await compiled.run({ threadId: "svc-run-2" });
    expect(result.status).toBe("completed");
    const check = (result.state.outputs as Record<string, unknown>)?.["check"] as {
      status: string;
    };
    const halt = (result.state.outputs as Record<string, unknown>)?.["halt"] as {
      status: string;
    };
    expect(check.status).toBe("running");
    expect(halt.status).toBe("stopped");
  });

  it("survives HITL interrupt and cleans up on completion", async () => {
    const compiled = await compileGraph(
      serviceGraph({
        checkpoint: true,
        nodes: [
          {
            id: "start",
            type: "service",
            with: {
              name: "during-hitl",
              command: "node",
              args: ["-e", "setInterval(() => {}, 1000)"],
            },
          },
          {
            id: "approve",
            type: "hitl",
            with: { mode: "approve", message: "ok?" },
          },
        ],
      }),
      { checkpointer: "memory" },
    );

    const threadId = "svc-hitl-1";
    const interrupted = await compiled.run({
      threadId,
      onInterrupt: "fail",
    });
    expect(interrupted.status).toBe("interrupted");
    // Still running while paused for HITL
    expect(statusService(threadId, "during-hitl").status).toBe("running");
    expect(listThreadServices(threadId)).toHaveLength(1);

    const resumed = await compiled.resume({
      threadId,
      resume: true,
      onInterrupt: "fail",
    });
    expect(resumed.status).toBe("completed");
    expect(statusService(threadId, "during-hitl").status).toBe("not_found");
  });

  it("respects keepAlive and terminateOnEnd: false", async () => {
    const compiled = await compileGraph(
      serviceGraph({
        terminateOnEnd: false,
        nodes: [
          {
            id: "start",
            type: "service",
            with: {
              name: "linger",
              command: "node",
              args: ["-e", "setInterval(() => {}, 1000)"],
              keepAlive: true,
            },
          },
        ],
      }),
      {},
    );

    const threadId = "svc-keepalive";
    const result = await compiled.run({ threadId });
    expect(result.status).toBe("completed");
    // terminateOnEnd false → nothing auto-stopped
    expect(statusService(threadId, "linger").status).toBe("running");
  });

  it("keepAlive survives terminateOnEnd: true", async () => {
    const compiled = await compileGraph(
      serviceGraph({
        terminateOnEnd: true,
        nodes: [
          {
            id: "start",
            type: "service",
            with: {
              name: "keep",
              command: "node",
              args: ["-e", "setInterval(() => {}, 1000)"],
              keepAlive: true,
            },
          },
        ],
      }),
      {},
    );

    const threadId = "svc-keepalive-2";
    const result = await compiled.run({ threadId });
    expect(result.status).toBe("completed");
    expect(statusService(threadId, "keep").status).toBe("running");
  });
});
