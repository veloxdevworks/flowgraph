import { afterEach, describe, expect, it } from "vitest";
import { compileGraph } from "../compiler.js";
import { createScriptedProvider } from "./mock.js";
import {
  startService,
  resetServiceManager,
  statusService,
} from "../runtime/service-manager.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import "./list-services.js";

afterEach(async () => {
  await resetServiceManager();
});

function agentGraph(tools: { function: string }[]): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "svc-tools-graph" },
    state: { channels: { answer: { type: "object" } } },
    nodes: [
      {
        id: "agent",
        type: "agent",
        provider: "scripted-svc",
        with: {
          prompt: "Inspect services",
          tools,
          output: { to: "answer" },
        },
      },
    ],
    edges: [
      { from: "START", to: "agent" },
      { from: "agent", to: "END" },
    ],
    runtime: { checkpoint: { enabled: false, backend: "memory" } },
  } as unknown as GraphSpec;
}

describe("list_services / service_status tools", () => {
  it("list_services returns tracked services for the thread", async () => {
    const threadId = "svc-tools-list";
    await startService(threadId, {
      name: "vite",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    await startService(threadId, {
      name: "api",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
    });

    const scripted = createScriptedProvider("scripted-svc", async (_req, ctx) => {
      const listed = (await ctx.invokeTool("list_services", {})) as {
        services: { name: string; status: string }[];
        count: number;
      };
      return {
        output: listed,
        stopReason: "done",
      };
    });

    const compiled = await compileGraph(agentGraph([{ function: "list_services" }]), {
      providers: [scripted],
    });
    const result = await compiled.run({ threadId });
    expect(result.status).toBe("completed");
    const answer = result.state["answer"] as {
      services: { name: string; status: string }[];
      count: number;
    };
    expect(answer.count).toBe(2);
    expect(answer.services.map((s) => s.name).sort()).toEqual(["api", "vite"]);
    expect(answer.services.every((s) => s.status === "running")).toBe(true);
  });

  it("list_services returns empty when none are running", async () => {
    const scripted = createScriptedProvider("scripted-svc", async (_req, ctx) => {
      const listed = await ctx.invokeTool("list_services", {});
      return { output: listed, stopReason: "done" };
    });
    const compiled = await compileGraph(agentGraph([{ function: "list_services" }]), {
      providers: [scripted],
    });
    const result = await compiled.run({ threadId: "svc-tools-empty" });
    expect(result.status).toBe("completed");
    expect(result.state["answer"]).toEqual({ services: [], count: 0 });
  });

  it("service_status returns a single service or not_found", async () => {
    const threadId = "svc-tools-status";
    await startService(threadId, {
      name: "db",
      command: "node",
      args: ["-e", "setInterval(() => {}, 1000)"],
    });

    const scripted = createScriptedProvider("scripted-svc", async (_req, ctx) => {
      const found = await ctx.invokeTool("service_status", { name: "db" });
      const missing = await ctx.invokeTool("service_status", { name: "ghost" });
      return { output: { found, missing }, stopReason: "done" };
    });

    const compiled = await compileGraph(agentGraph([{ function: "service_status" }]), {
      providers: [scripted],
    });
    const result = await compiled.run({ threadId });
    expect(result.status).toBe("completed");
    const answer = result.state["answer"] as {
      found: { name: string; status: string; pid?: number };
      missing: { name: string; status: string };
    };
    expect(answer.found.name).toBe("db");
    expect(answer.found.status).toBe("running");
    expect(answer.found.pid).toBeTypeOf("number");
    expect(answer.missing).toEqual({ name: "ghost", status: "not_found", keepAlive: false });
    // Tools are read-only; termination at run end is expected (terminateOnEnd default).
    expect(statusService(threadId, "db").status).toBe("not_found");
  });

  it("service_status rejects a missing name", async () => {
    const scripted = createScriptedProvider("scripted-svc", async (_req, ctx) => {
      await ctx.invokeTool("service_status", {});
      return { output: {}, stopReason: "done" };
    });
    const compiled = await compileGraph(agentGraph([{ function: "service_status" }]), {
      providers: [scripted],
    });
    const result = await compiled.run({ threadId: "svc-tools-bad" });
    expect(result.status).toBe("error");
    expect(result.error?.message).toMatch(/requires a "name"/);
  });
});
