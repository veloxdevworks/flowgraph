import { describe, expect, it, vi } from "vitest";
import { WorkshopController } from "./controller.js";
import { WorkshopSession } from "./session.js";
import type { MintedVoiceToken, WorkshopContract } from "./types.js";

const token: MintedVoiceToken = { token: "t", url: "wss://example", model: "m", provider: "xai" };
const contract: WorkshopContract = {
  mode: "workshop",
  agenda: [{ id: "scope", title: "Scope" }],
  fallback: "form",
  schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  limits: { maxMinutes: 1 },
  allowPartial: true,
};

function fakeSocket() {
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const sent: any[] = [];
  const ws = {
    readyState: 1,
    binaryType: "",
    addEventListener(type: string, fn: (ev: unknown) => void) {
      (listeners[type] ??= []).push(fn);
    },
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    close: vi.fn(() => {
      for (const fn of listeners["close"] ?? []) fn({});
    }),
    emit(type: string, ev: unknown = {}) {
      for (const fn of listeners[type] ?? []) fn(ev);
    },
  };
  return { ws, sent };
}
const msg = (o: unknown) => ({ data: JSON.stringify(o) });
const toolEvent = (name: string, args: unknown, id = "c1") =>
  msg({ type: "response.function_call_arguments.done", name, call_id: id, arguments: JSON.stringify(args) });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("WorkshopSession with a controller", () => {
  it("advertises controller tools and instructions, applies calls, records transcripts, closes on finish", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const controller = new WorkshopController(contract);
    const { ws, sent } = fakeSocket();
    const onFinished = vi.fn();
    const onTranscript = vi.fn();
    const session = new WorkshopSession(token, contract, { onFinished, onTranscript }, (() => ws) as never, { controller });
    await session.start();
    ws.emit("open");
    const upd = sent[0].session;
    expect(upd.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["set_field", "append_to_list", "finish"]));
    expect(upd.instructions).toBe(controller.instructions());
    expect(session.timeLimitMs).toBe(60_000);

    ws.emit("message", msg({ type: "conversation.item.input_audio_transcription.completed", transcript: "hi there" }));
    await tick();
    expect(controller.state.turns).toBe(1);
    expect(onTranscript).toHaveBeenCalledTimes(1);

    ws.emit("message", toolEvent("set_field", { path: "title", value: "SSO" }));
    await tick();
    expect(controller.state.draft).toEqual({ title: "SSO" });
    const out = sent.find((m) => m.item?.type === "function_call_output");
    expect(JSON.parse(out.item.output).status.missing).toEqual([]);
    expect(sent.at(-1).type).toBe("response.create");

    ws.emit("message", toolEvent("finish", {}, "c2"));
    await tick();
    expect(controller.ended).toBe(true);
    expect(onFinished).toHaveBeenCalledWith("completed");
    expect(ws.close).toHaveBeenCalled();
    expect(sent.at(-1).type).toBe("conversation.item.create"); // no response.create after finish
    vi.unstubAllGlobals();
  });

  it("falls through to onToolCall for tools the controller does not serve", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const controller = new WorkshopController(contract);
    const { ws, sent } = fakeSocket();
    const onToolCall = vi.fn(async () => ({ content: "file" }));
    const session = new WorkshopSession(token, contract, { onToolCall }, (() => ws) as never, { controller, readArtifact: true });
    await session.start();
    ws.emit("open");
    expect(sent[0].session.tools.map((t: any) => t.name)).toContain("read_artifact");
    ws.emit("message", toolEvent("read_artifact", { path: "a" }));
    await tick();
    expect(JSON.parse(sent.find((m) => m.item?.type === "function_call_output").item.output)).toEqual({ content: "file" });
    vi.unstubAllGlobals();
  });

  it("ends partially on the time limit when the contract allows it", async () => {
    vi.useFakeTimers();
    const controller = new WorkshopController(contract);
    const { ws } = fakeSocket();
    const onTimeLimit = vi.fn();
    const session = new WorkshopSession(token, contract, { onTimeLimit }, (() => ws) as never, { controller });
    await session.start();
    vi.advanceTimersByTime(60_001);
    expect(onTimeLimit).toHaveBeenCalled();
    expect(controller.state.endedReason).toBe("timeout");
    vi.useRealTimers();
  });
});
