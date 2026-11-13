import { describe, expect, it } from "vitest";
import { anthropicModel, toAnthropicMessages } from "./models/anthropic.js";
import { openAICompatibleModel } from "./models/openai-compatible.js";
import type { FacilitatorMessage } from "./text-facilitator.js";
import type { FacilitatorToolDef } from "./tools.js";

const tools: FacilitatorToolDef[] = [
  { type: "function", name: "set_field", description: "d", parameters: { type: "object", properties: {} } },
];
const messages: FacilitatorMessage[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "calling", toolCalls: [{ id: "t1", name: "set_field", args: { path: "a", value: 1 } }] },
  { role: "tool", toolCallId: "t1", name: "set_field", content: '{"ok":true}' },
  { role: "user", content: "next" },
];

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("openAICompatibleModel", () => {
  it("sends chat completions with tools and parses tool_calls", async () => {
    const { impl, calls } = fakeFetch(200, {
      choices: [
        {
          message: {
            content: "ok",
            tool_calls: [{ id: "c1", type: "function", function: { name: "finish", arguments: '{"reason":"completed"}' } }],
          },
        },
      ],
    });
    const m = openAICompatibleModel({ apiKey: "sk-secret", model: "m1", fetchImpl: impl, headers: { "x-extra": "1" } });
    const out = await m.respond({ system: "sys", messages, tools });
    expect(out).toEqual({ text: "ok", toolCalls: [{ id: "c1", name: "finish", args: { reason: "completed" } }] });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-secret");
    expect(headers["x-extra"]).toBe("1");
    const body = JSON.parse(call.init.body as string);
    expect(body.model).toBe("m1");
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages[2].tool_calls[0]).toEqual({
      id: "t1",
      type: "function",
      function: { name: "set_field", arguments: '{"path":"a","value":1}' },
    });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "t1", content: '{"ok":true}' });
    expect(body.tools[0]).toEqual({
      type: "function",
      function: { name: "set_field", description: "d", parameters: { type: "object", properties: {} } },
    });
  });

  it("honours baseUrl, tolerates bad tool arguments, requires a model", async () => {
    const { impl, calls } = fakeFetch(200, {
      choices: [{ message: { content: null, tool_calls: [{ id: "c", function: { name: "x", arguments: "{oops" } }] } }],
    });
    const out = await openAICompatibleModel({ apiKey: "k", model: "m", baseUrl: "https://api.x.ai/v1/", fetchImpl: impl }).respond({
      system: "s",
      messages: [],
      tools: [],
    });
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(JSON.parse(calls[0]!.init.body as string).tools).toBeUndefined();
    expect(out).toEqual({ toolCalls: [{ id: "c", name: "x", args: {} }] });
    expect(() => openAICompatibleModel({ apiKey: "k", model: "" })).toThrow(/model/);
  });

  it("never leaks the API key in errors", async () => {
    const { impl } = fakeFetch(401, "bad key sk-secret-123");
    const m = openAICompatibleModel({ apiKey: "sk-secret-123", model: "m", fetchImpl: impl });
    const err = await m.respond({ system: "s", messages, tools }).catch((e: Error) => e);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).not.toContain("sk-secret-123");
  });
});

describe("anthropicModel", () => {
  it("sends the Messages API shape and parses tool_use", async () => {
    const { impl, calls } = fakeFetch(200, {
      content: [
        { type: "text", text: "sure" },
        { type: "tool_use", id: "tu1", name: "finish", input: { reason: "completed" } },
      ],
    });
    const m = anthropicModel({ apiKey: "ak-secret", model: "claude-x", fetchImpl: impl, maxTokens: 512 });
    const out = await m.respond({ system: "sys", messages, tools });
    expect(out).toEqual({ text: "sure", toolCalls: [{ id: "tu1", name: "finish", args: { reason: "completed" } }] });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("ak-secret");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(call.init.body as string);
    expect(body).toMatchObject({ model: "claude-x", max_tokens: 512, system: "sys" });
    expect(body.tools[0]).toEqual({ name: "set_field", description: "d", input_schema: { type: "object", properties: {} } });
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_use", id: "t1", name: "set_field", input: { path: "a", value: 1 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: '{"ok":true}' },
          { type: "text", text: "next" },
        ],
      },
    ]);
  });

  it("merges same-role turns, starts with a user turn, requires a model, hides the key", async () => {
    const msgs = toAnthropicMessages([
      { role: "assistant", content: "hello" },
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[2]!.content).toHaveLength(2);
    expect(() => anthropicModel({ apiKey: "k", model: "" })).toThrow(/model/);
    const { impl } = fakeFetch(403, "denied ak-secret");
    const err = await anthropicModel({ apiKey: "ak-secret", model: "m", fetchImpl: impl })
      .respond({ system: "s", messages, tools })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain("403");
    expect((err as Error).message).not.toContain("ak-secret");
  });
});
