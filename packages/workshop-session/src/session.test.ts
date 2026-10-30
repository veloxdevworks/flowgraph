import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkshopSession } from "./session.js";
import { FACILITATOR_TOOLS, READ_ARTIFACT_TOOL } from "./tools.js";
import { WORKSHOP_SESSION_MAX_MS, type MintedVoiceToken, type WorkshopContract } from "./types.js";

const token: MintedVoiceToken = { token: "t", url: "wss://example", model: "grok-voice-latest", provider: "xai" };

function fakeSocket() {
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const sent: unknown[] = [];
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
    emit(type: string) {
      for (const fn of listeners[type] ?? []) fn({});
    },
  };
  return { ws, sent };
}

function contract(extra: Partial<WorkshopContract> = {}): WorkshopContract {
  return { mode: "workshop", agenda: [{ id: "scope", title: "Scope" }], fallback: "form", ...extra };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkshopSession tools and limits", () => {
  it("does not advertise read_artifact unless the client opts in", async () => {
    expect(FACILITATOR_TOOLS.map((t) => t.name)).not.toContain("read_artifact");
    const a = fakeSocket();
    const s1 = new WorkshopSession(token, contract(), {}, (() => a.ws) as never);
    await s1.start();
    a.ws.emit("open");
    const names1 = (a.sent[0] as { session: { tools: Array<{ name: string }> } }).session.tools.map((t) => t.name);
    expect(names1).not.toContain("read_artifact");

    const b = fakeSocket();
    const s2 = new WorkshopSession(token, contract(), {}, (() => b.ws) as never);
    await s2.start({ tools: [...FACILITATOR_TOOLS, READ_ARTIFACT_TOOL] });
    b.ws.emit("open");
    const names2 = (b.sent[0] as { session: { tools: Array<{ name: string }> } }).session.tools.map((t) => t.name);
    expect(names2).toContain("read_artifact");
  });

  it("enforces limits.maxMinutes: fires onTimeLimit and closes without onExpired", async () => {
    vi.useFakeTimers();
    const { ws } = fakeSocket();
    const onTimeLimit = vi.fn();
    const onExpired = vi.fn();
    const session = new WorkshopSession(token, contract({ limits: { maxMinutes: 2 } }), { onTimeLimit, onExpired }, (() => ws) as never);
    expect(session.timeLimitMs).toBe(120_000);
    await session.start();
    vi.advanceTimersByTime(119_999);
    expect(onTimeLimit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeLimit).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("defaults the time limit and clears it on close", async () => {
    vi.useFakeTimers();
    const { ws } = fakeSocket();
    const onTimeLimit = vi.fn();
    const session = new WorkshopSession(token, contract(), { onTimeLimit }, (() => ws) as never);
    expect(session.timeLimitMs).toBe(WORKSHOP_SESSION_MAX_MS);
    await session.start();
    session.close();
    vi.advanceTimersByTime(WORKSHOP_SESSION_MAX_MS * 2);
    expect(onTimeLimit).not.toHaveBeenCalled();
  });
});

describe("WorkshopSession.buildInstructions", () => {
  it("includes agenda, schema, and facilitator prompt", () => {
    const session = new WorkshopSession(
      {
        token: "t",
        url: "wss://example",
        model: "grok-voice-latest",
        provider: "xai",
      },
      {
        mode: "workshop",
        fallback: "form",
        agenda: [{ id: "scope", title: "Scope", description: "what we ship" }],
        schema: { type: "object", properties: { title: { type: "string" } } },
        facilitator: "Cover every item.",
        context: "SSO research",
      },
    );
    const text = session.buildInstructions("User: hello");
    expect(text).toContain("Cover every item.");
    expect(text).toContain("scope: Scope");
    expect(text).toContain("SSO research");
    expect(text).toContain("Prior transcript");
    expect(text).toContain("update_draft");
  });
});
