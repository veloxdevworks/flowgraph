import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRest } from "./rest.js";
import { handleAgentCore } from "./agentcore.js";
import type { RunService } from "../run-service.js";

function postReq(body: string): IncomingMessage {
  return Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method: "POST" }) as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader() {},
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    end(payload: string) {
      this.body = JSON.parse(payload);
    },
  };
  return res as unknown as ServerResponse & { statusCode: number; body: unknown };
}

function service(): RunService & { resumeRun: ReturnType<typeof vi.fn> } {
  return {
    resumeRun: vi.fn(async (req: { threadId: string }) => ({ threadId: req.threadId, status: "running" })),
    config: {},
  } as unknown as RunService & { resumeRun: ReturnType<typeof vi.fn> };
}

const missing: Array<[string, string]> = [
  ["{}", "{}"],
  ["an empty body", ""],
  ["a misspelled key", '{"resum":true}'],
];

describe("POST /runs/:threadId/resume without a resume value", () => {
  for (const [label, body] of missing) {
    it(`answers 400 for ${label} and does not resume the thread`, async () => {
      const svc = service();
      const res = mockRes();
      await handleRest(postReq(body), res, svc, new URL("http://localhost/runs/t1/resume"));
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: "RESUME_REQUIRED" });
      expect(svc.resumeRun).not.toHaveBeenCalled();
    });
  }

  it("still passes a falsy resume value through", async () => {
    for (const value of [false, null, 0, ""]) {
      const svc = service();
      const res = mockRes();
      await handleRest(postReq(JSON.stringify({ resume: value })), res, svc, new URL("http://localhost/runs/t1/resume"));
      expect(res.statusCode).toBe(202);
      expect(svc.resumeRun).toHaveBeenCalledWith({ threadId: "t1", resume: value }, undefined);
    }
  });
});

describe("POST /invocations action resume without a resume value", () => {
  for (const [label, body] of [
    ["no resume key", '{"action":"resume","threadId":"t1","stream":false}'],
    ["a misspelled key", '{"action":"resume","threadId":"t1","resum":true,"stream":false}'],
  ] as const) {
    it(`answers 400 for ${label} and does not resume the thread`, async () => {
      const svc = service();
      const res = mockRes();
      await handleAgentCore(postReq(body), res, svc, "/invocations");
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: "RESUME_REQUIRED" });
      expect(svc.resumeRun).not.toHaveBeenCalled();
    });
  }

  it("still passes a falsy resume value through", async () => {
    const svc = service();
    const res = mockRes();
    await handleAgentCore(postReq('{"action":"resume","threadId":"t1","resume":false,"stream":false}'), res, svc, "/invocations");
    expect(res.statusCode).toBe(200);
    expect(svc.resumeRun).toHaveBeenCalledWith({ threadId: "t1", resume: false }, undefined);
  });
});
