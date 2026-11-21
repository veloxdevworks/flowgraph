import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { compileGraph, registerTool, type GraphSpec } from "../../index.js";
import { createLangChainProvider, type ChatModelLike } from "./index.js";
import { createLangChainProviderFromConfig } from "./factory.js";
import { providerConfigDiagnostics } from "../diagnostics.js";

// A local stand-in for the vendor HTTP APIs: it records each request body and
// answers in the vendor's wire format. No request leaves 127.0.0.1.
type Stub = { url: string; bodies: Array<Record<string, unknown>>; close(): Promise<void> };

function openAiReply(body: Record<string, unknown>): unknown {
  const messages = body["messages"] as Array<{ role?: string }> | undefined;
  const answered = messages?.at(-1)?.role === "tool";
  const tools = answered ? undefined : body["tools"] as Array<{ function?: { name?: string } }> | undefined;
  const json = JSON.stringify({ decision: "approve" });
  const message = tools?.length
    ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tools[0]!.function!.name, arguments: json } }] }
    : { role: "assistant", content: body["response_format"] ? json : "ok" };
  return {
    id: "chatcmpl-stub", object: "chat.completion", created: 0, model: body["model"],
    choices: [{ index: 0, message, finish_reason: tools?.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
}

function anthropicReply(body: Record<string, unknown>): unknown {
  const tools = body["tools"] as Array<{ name?: string }> | undefined;
  const content = tools?.length
    ? [{ type: "tool_use", id: "toolu_1", name: tools[0]!.name, input: { decision: "approve" } }]
    : [{ type: "text", text: "ok" }];
  return {
    id: "msg_stub", type: "message", role: "assistant", model: body["model"], content,
    stop_reason: tools?.length ? "tool_use" : "end_turn", stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  };
}

async function startStub(reply: (body: Record<string, unknown>) => unknown): Promise<Stub> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const SCHEMA = {
  type: "object",
  properties: { decision: { type: "string", enum: ["approve", "reject"] } },
  required: ["decision"],
};

function spec(nodes: Array<{ id: string; model?: string; with?: Record<string, unknown> }>): GraphSpec {
  return {
    metadata: { name: "lc-vendor-overrides" },
    state: { channels: Object.fromEntries(nodes.map((n) => [`out_${n.id}`, { type: "object" }])) },
    nodes: nodes.map((n) => ({
      id: n.id,
      type: "agent",
      provider: "langchain",
      ...(n.model ? { model: n.model } : {}),
      with: { prompt: "Hi", output: { to: `out_${n.id}` }, ...n.with },
    })),
    edges: [
      { from: "START", to: nodes[0]!.id },
      ...nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })),
      { from: nodes.at(-1)!.id, to: "END" },
    ],
    runtime: { checkpoint: { enabled: false } },
  } as unknown as GraphSpec;
}

// Vendor classes are typed against their own @langchain/core copy; the provider takes them structurally.
async function run(model: unknown, graph: GraphSpec) {
  const compiled = await compileGraph(graph, { providers: [createLangChainProvider(model as ChatModelLike)] });
  return compiled.run({ input: {} });
}

function sent(body: Record<string, unknown>) {
  return { model: body["model"], maxTokens: body["max_tokens"] ?? body["max_completion_tokens"] };
}

describe("LangChain applies node model and maxTokens to real vendor clients", () => {
  let stub: Stub;
  afterEach(async () => {
    vi.unstubAllEnvs();
    await stub?.close();
  });

  describe("ChatOpenAI", () => {
    beforeEach(async () => { stub = await startStub(openAiReply); });
    const chat = (fields: Record<string, unknown> = {}) =>
      new ChatOpenAI({ model: "gpt-4o-mini", maxTokens: 100, apiKey: "sk-stub", maxRetries: 0, configuration: { baseURL: `${stub.url}/v1` }, ...fields });

    it("sends the node model and with.maxTokens, and leaves other nodes on the configured values", async () => {
      const r = await run(chat(), spec([
        { id: "override", model: "gpt-override", with: { maxTokens: 7 } },
        { id: "plain" },
      ]));
      expect(r.status).toBe("completed");
      expect(stub.bodies.map(sent)).toEqual([
        { model: "gpt-override", maxTokens: 7 },
        { model: "gpt-4o-mini", maxTokens: 100 },
      ]);
    });

    it("overrides one field without dropping the other or the client settings", async () => {
      const r = await run(chat({ temperature: 0.25 }), spec([{ id: "a", with: { maxTokens: 9 } }, { id: "b", model: "gpt-other" }]));
      expect(r.status).toBe("completed");
      expect(stub.bodies.map(sent)).toEqual([
        { model: "gpt-4o-mini", maxTokens: 9 },
        { model: "gpt-other", maxTokens: 100 },
      ]);
      expect(stub.bodies.every((b) => b["temperature"] === 0.25)).toBe(true);
    });

    it("wins over maxCompletionTokens and modelName given to the constructor", async () => {
      const model = new ChatOpenAI({ modelName: "gpt-4o-mini", maxCompletionTokens: 100, apiKey: "sk-stub", maxRetries: 0, configuration: { baseURL: `${stub.url}/v1` } });
      const r = await run(model, spec([{ id: "a", model: "gpt-override", with: { maxTokens: 7 } }]));
      expect(r.status).toBe("completed");
      expect(sent(stub.bodies[0]!)).toEqual({ model: "gpt-override", maxTokens: 7 });
    });

    it("keeps the overrides on schema-constrained output", async () => {
      const r = await run(chat(), spec([{ id: "a", model: "gpt-override", with: { maxTokens: 7, schema: SCHEMA } }]));
      expect(r.status).toBe("completed");
      expect(r.state["out_a"]).toEqual({ decision: "approve" });
      expect(stub.bodies).toHaveLength(1);
      expect(sent(stub.bodies[0]!)).toEqual({ model: "gpt-override", maxTokens: 7 });
    });

    it("keeps the overrides on every turn of a tool-calling loop", async () => {
      registerTool({ name: "stub-weather", handler: () => ({ tempF: 72 }) });
      const r = await run(chat(), spec([{ id: "a", model: "gpt-override", with: { maxTokens: 7, tools: [{ function: "stub-weather" }] } }]));
      expect(r.status).toBe("completed");
      expect(stub.bodies).toHaveLength(2);
      for (const body of stub.bodies) {
        expect(sent(body)).toEqual({ model: "gpt-override", maxTokens: 7 });
        expect(body["tools"]).toHaveLength(1);
      }
    });

    it("applies them to a provider built from a providers block", async () => {
      vi.stubEnv("FG_STUB_OPENAI_KEY", "sk-stub");
      const provider = await createLangChainProviderFromConfig(
        "langchain",
        { kind: "langchain", vendor: "openai", model: "gpt-4o-mini", options: { maxTokens: 100 }, apiKeyEnv: "FG_STUB_OPENAI_KEY", baseUrl: `${stub.url}/v1` },
        { secrets: ["FG_STUB_OPENAI_KEY"] },
      );
      const compiled = await compileGraph(spec([{ id: "a", model: "gpt-override", with: { maxTokens: 7 } }]), { providers: [provider] });
      const r = await compiled.run({ input: {} });
      expect(r.status).toBe("completed");
      expect(sent(stub.bodies[0]!)).toEqual({ model: "gpt-override", maxTokens: 7 });
    });
  });

  describe("ChatAnthropic", () => {
    beforeEach(async () => { stub = await startStub(anthropicReply); });
    const chat = () =>
      new ChatAnthropic({ model: "claude-3-5-haiku-latest", maxTokens: 100, apiKey: "sk-ant-stub", maxRetries: 0, anthropicApiUrl: stub.url });

    it("sends the node model and with.maxTokens", async () => {
      const r = await run(chat(), spec([
        { id: "override", model: "claude-override", with: { maxTokens: 7 } },
        { id: "plain" },
      ]));
      expect(r.status).toBe("completed");
      expect(stub.bodies.map(sent)).toEqual([
        { model: "claude-override", maxTokens: 7 },
        { model: "claude-3-5-haiku-latest", maxTokens: 100 },
      ]);
    });

    it("keeps the overrides on schema-constrained output", async () => {
      const r = await run(chat(), spec([{ id: "a", model: "claude-override", with: { maxTokens: 7, schema: SCHEMA } }]));
      expect(r.status).toBe("completed");
      expect(r.state["out_a"]).toEqual({ decision: "approve" });
      expect(stub.bodies).toHaveLength(1);
      expect(sent(stub.bodies[0]!)).toEqual({ model: "claude-override", maxTokens: 7 });
    });
  });

  it("does not warn that ChatOpenAI or ChatAnthropic cannot be rebuilt", () => {
    const graph = spec([{ id: "a", model: "m", with: { maxTokens: 7 } }]);
    for (const model of [new ChatOpenAI({ model: "gpt-4o-mini", apiKey: "sk-stub" }), new ChatAnthropic({ model: "claude-3-5-haiku-latest", apiKey: "sk-ant-stub" })]) {
      const diags = providerConfigDiagnostics(graph, [createLangChainProvider(model as unknown as ChatModelLike)]);
      expect(diags.filter((d) => d.message.includes("withModelOverrides"))).toEqual([]);
    }
  });
});
