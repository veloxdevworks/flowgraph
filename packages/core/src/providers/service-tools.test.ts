import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import { compileGraph } from "../compiler.js";
import { createScriptedProvider } from "./mock.js";
import {
  listThreadServices,
  resetServiceManager,
  statusService,
} from "../runtime/service-manager.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import "./service-tools.js";
import "./list-services.js";

afterEach(async () => {
  await resetServiceManager();
});

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

function agentGraph(
  tools: { function: string }[],
  opts: { checkpoint?: boolean } = {},
): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "agent-svc-manage" },
    state: { channels: { answer: { type: "object" } } },
    nodes: [
      {
        id: "agent",
        type: "agent",
        provider: "scripted-manage",
        with: {
          prompt: "Manage services",
          tools,
          output: { to: "answer" },
        },
      },
    ],
    edges: [
      { from: "START", to: "agent" },
      { from: "agent", to: "END" },
    ],
    runtime: {
      checkpoint: {
        enabled: opts.checkpoint ?? false,
        backend: "memory",
      },
    },
  } as unknown as GraphSpec;
}

describe("start_service / stop_service / restart_service tools", () => {
  it("starts a service with a ready.port probe and tracks it", async () => {
    const port = await freePort();
    const threadId = "agent-start-1";

    const scripted = createScriptedProvider("scripted-manage", async (_req, ctx) => {
      const started = await ctx.invokeTool("start_service", {
        name: "api",
        command: "node",
        args: [
          "-e",
          `require('http').createServer((q,s)=>s.end('ok')).listen(${port}, '127.0.0.1')`,
        ],
        ready: { port },
        readyTimeout: "5s",
        readyInterval: "50ms",
      });
      const listed = await ctx.invokeTool("list_services", {});
      return { output: { started, listed }, stopReason: "done" };
    });

    const compiled = await compileGraph(
      agentGraph([{ function: "start_service" }, { function: "list_services" }]),
      { providers: [scripted] },
    );
    const result = await compiled.run({ threadId });
    expect(result.status).toBe("completed");

    const answer = result.state["answer"] as {
      started: { name: string; status: string; port: number; pid: number };
      listed: { count: number; services: { name: string }[] };
    };
    expect(answer.started.name).toBe("api");
    expect(answer.started.status).toBe("running");
    expect(answer.started.port).toBe(port);
    expect(answer.started.pid).toBeTypeOf("number");
    expect(answer.listed.count).toBe(1);
    // Auto-cleaned at run end
    expect(statusService(threadId, "api").status).toBe("not_found");
  });

  it("dedupes start_service for the same name", async () => {
    const threadId = "agent-dedupe-1";
    const scripted = createScriptedProvider("scripted-manage", async (_req, ctx) => {
      const first = (await ctx.invokeTool("start_service", {
        name: "dup",
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000)"],
      })) as { pid: number };
      const second = (await ctx.invokeTool("start_service", {
        name: "dup",
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000)"],
      })) as { pid: number };
      return {
        output: { firstPid: first.pid, secondPid: second.pid, count: listThreadServices(threadId).length },
        stopReason: "done",
      };
    });

    const compiled = await compileGraph(agentGraph([{ function: "start_service" }]), {
      providers: [scripted],
    });
    const result = await compiled.run({ threadId });
    expect(result.status).toBe("completed");
    const answer = result.state["answer"] as {
      firstPid: number;
      secondPid: number;
      count: number;
    };
    expect(answer.secondPid).toBe(answer.firstPid);
    expect(answer.count).toBe(1);
  });

  it("stop_service removes a running service from the registry", async () => {
    const threadId = "agent-stop-1";
    const scripted = createScriptedProvider("scripted-manage", async (_req, ctx) => {
      await ctx.invokeTool("start_service", {
        name: "tmp",
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000)"],
      });
      const stopped = await ctx.invokeTool("stop_service", { name: "tmp" });
      const after = statusService(threadId, "tmp");
      return { output: { stopped, after }, stopReason: "done" };
    });

    const compiled = await compileGraph(
      agentGraph([{ function: "start_service" }, { function: "stop_service" }]),
      { providers: [scripted] },
    );
    const result = await compiled.run({ threadId });
    expect(result.status).toBe("completed");
    const answer = result.state["answer"] as {
      stopped: { status: string };
      after: { status: string };
    };
    expect(answer.stopped.status).toBe("stopped");
    expect(answer.after.status).toBe("not_found");
  });

  it("restart_service yields a new pid", async () => {
    const threadId = "agent-restart-1";
    const scripted = createScriptedProvider("scripted-manage", async (_req, ctx) => {
      const first = (await ctx.invokeTool("start_service", {
        name: "r",
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000)"],
      })) as { pid: number };
      const second = (await ctx.invokeTool("restart_service", {
        name: "r",
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000)"],
      })) as { pid: number; status: string };
      return {
        output: { firstPid: first.pid, secondPid: second.pid, status: second.status },
        stopReason: "done",
      };
    });

    const compiled = await compileGraph(
      agentGraph([{ function: "start_service" }, { function: "restart_service" }]),
      { providers: [scripted] },
    );
    const result = await compiled.run({ threadId });
    expect(result.status).toBe("completed");
    const answer = result.state["answer"] as {
      firstPid: number;
      secondPid: number;
      status: string;
    };
    expect(answer.status).toBe("running");
    expect(answer.secondPid).not.toBe(answer.firstPid);
  });

  it("survives HITL pause and cleans up on completion", async () => {
    const threadId = "agent-hitl-svc";
    // Graph: agent starts a service, then HITL interrupts; resume completes.
    const spec: GraphSpec = {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "agent-svc-hitl" },
      state: { channels: { answer: { type: "object" } } },
      nodes: [
        {
          id: "agent",
          type: "agent",
          provider: "scripted-manage",
          with: {
            prompt: "start then pause",
            tools: [{ function: "start_service" }],
            output: { to: "answer" },
          },
        },
        {
          id: "approve",
          type: "hitl",
          with: { mode: "approve", message: "ok?" },
        },
      ],
      edges: [
        { from: "START", to: "agent" },
        { from: "agent", to: "approve" },
        { from: "approve", to: "END" },
      ],
      runtime: { checkpoint: { enabled: true, backend: "memory" } },
    } as unknown as GraphSpec;

    const scripted = createScriptedProvider("scripted-manage", async (_req, ctx) => {
      const started = await ctx.invokeTool("start_service", {
        name: "during-hitl",
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000)"],
      });
      return { output: started, stopReason: "done" };
    });

    const compiled = await compileGraph(spec, {
      providers: [scripted],
      checkpointer: "memory",
    });

    const interrupted = await compiled.run({ threadId, onInterrupt: "fail" });
    expect(interrupted.status).toBe("interrupted");
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

  it("rejects start_service without command", async () => {
    const scripted = createScriptedProvider("scripted-manage", async (_req, ctx) => {
      await ctx.invokeTool("start_service", { name: "x" });
      return { output: {}, stopReason: "done" };
    });
    const compiled = await compileGraph(agentGraph([{ function: "start_service" }]), {
      providers: [scripted],
    });
    const result = await compiled.run({ threadId: "agent-bad-start" });
    expect(result.status).toBe("error");
    expect(result.error?.message).toMatch(/requires a "command"/);
  });

  it("rejects stop_service without name", async () => {
    const scripted = createScriptedProvider("scripted-manage", async (_req, ctx) => {
      await ctx.invokeTool("stop_service", {});
      return { output: {}, stopReason: "done" };
    });
    const compiled = await compileGraph(agentGraph([{ function: "stop_service" }]), {
      providers: [scripted],
    });
    const result = await compiled.run({ threadId: "agent-bad-stop" });
    expect(result.status).toBe("error");
    expect(result.error?.message).toMatch(/requires a "name"/);
  });
});
