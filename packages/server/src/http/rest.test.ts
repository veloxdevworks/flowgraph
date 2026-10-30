import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRest } from "./rest.js";
import { credentialStatus } from "../credentials.js";
import type { RunService } from "../run-service.js";

function mockRes(): ServerResponse & { statusCode?: number; body?: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    end(payload: string) {
      this.body = JSON.parse(payload);
    },
  };
  return res as unknown as ServerResponse & { statusCode?: number; body?: unknown };
}

describe("GET /healthz", () => {
  it("includes credentials introspection", async () => {
    const service = {
      registry: { activeCount: () => 0 },
      metrics: { snapshot: () => ({}) },
      config: {
        host: "0.0.0.0",
        port: 8080,
        graphStoreDir: "/tmp/fg",
        eventBufferSize: 10,
        databaseUrl: undefined,
      },
    } as unknown as RunService;
    const req = { method: "GET" } as IncomingMessage;
    const res = mockRes();
    const handled = await handleRest(req, res, service, new URL("http://localhost/healthz"));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ok?: boolean;
      credentials?: ReturnType<typeof credentialStatus>;
      identity?: { name?: string; version?: string; host?: string; port?: number };
    };
    expect(body.ok).toBe(true);
    expect(body.identity?.name).toBe("flowgraph-server");
    expect(body.identity?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.identity?.host).toBe("0.0.0.0");
    expect(body.identity?.port).toBe(8080);
    expect(body.credentials).toEqual(credentialStatus());
    expect(body.credentials).toEqual(
      expect.objectContaining({
        hasAwsKeys: expect.any(Boolean),
        hasBedrockIamHint: expect.any(Boolean),
        vendorKeys: expect.any(Array),
      }),
    );
    expect(
      body.credentials?.awsRegion === null || typeof body.credentials?.awsRegion === "string",
    ).toBe(true);
  });
});

describe("GET /runs", () => {
  it("returns the service listing", async () => {
    const service = {
      listRuns: async () => [
        {
          threadId: "t1",
          graphName: "demo",
          label: "Demo",
          status: "interrupted",
          updatedAt: "2026-01-01T00:00:00.000Z",
          active: false,
        },
      ],
      config: {},
    } as unknown as RunService;
    const req = { method: "GET" } as IncomingMessage;
    const res = mockRes();
    const handled = await handleRest(req, res, service, new URL("http://localhost/runs"));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      runs: [
        expect.objectContaining({ threadId: "t1", status: "interrupted", label: "Demo" }),
      ],
    });
  });
});

describe("POST /runs dryRun", () => {
  it("forwards dryRun to startRun", async () => {
    const startRun = vi.fn(async () => ({ threadId: "t1", runId: "r1", status: "started" }));
    const service = {
      startRun,
      config: { maxBodyBytes: 2_000_000 },
    } as unknown as RunService;
    const body = JSON.stringify({ threadId: "t1", yaml: "x: 1\n", dryRun: true });
    const req = {
      method: "POST",
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(body);
      },
    } as unknown as IncomingMessage;
    const res = mockRes();
    const handled = await handleRest(req, res, service, new URL("http://localhost/runs"));
    expect(handled).toBe(true);
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "t1", dryRun: true }),
    );
    expect(res.statusCode).toBe(202);
  });
});

describe("GET /runs/:threadId/journal", () => {
  it("returns events from the service", async () => {
    const service = {
      getJournal: () => [
        {
          id: "e1",
          type: "run.start",
          ts: "2026-01-01T00:00:00.000Z",
          runId: "r1",
          threadId: "t1",
          graph: "demo",
          scope: {},
          data: {},
          seq: 1,
        },
      ],
      config: {},
    } as unknown as RunService;
    const req = { method: "GET" } as IncomingMessage;
    const res = mockRes();
    const handled = await handleRest(
      req,
      res,
      service,
      new URL("http://localhost/runs/t1/journal"),
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      events: [expect.objectContaining({ type: "run.start", seq: 1 })],
    });
  });
});

describe("GET /runs/:threadId/issues", () => {
  it("returns the service issue list", async () => {
    const service = {
      listIssues: () => [
        {
          code: "TOOL_NOT_FOUND",
          severity: "warning",
          message: "go missing",
          raisedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      config: {},
    } as unknown as RunService;
    const req = { method: "GET" } as IncomingMessage;
    const res = mockRes();
    const handled = await handleRest(
      req,
      res,
      service,
      new URL("http://localhost/runs/t1/issues"),
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      issues: [expect.objectContaining({ code: "TOOL_NOT_FOUND", message: "go missing" })],
    });
  });
});

describe("POST /voice/client-secrets", () => {
  const VOICE_ENV = ["XAI_API_KEY", "GROK_API_KEY", "OPENAI_API_KEY"] as const;
  let savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedEnv = Object.fromEntries(VOICE_ENV.map((k) => [k, process.env[k]]));
    for (const k of VOICE_ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const k of VOICE_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.unstubAllGlobals();
  });

  const authed = { maxBodyBytes: 2_000_000, authToken: "secret" };
  async function post(config: Record<string, unknown>, body: unknown) {
    const service = { config } as unknown as RunService;
    const req = {
      method: "POST",
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify(body));
      },
    } as unknown as IncomingMessage;
    const res = mockRes();
    const handled = await handleRest(req, res, service, new URL("http://localhost/voice/client-secrets"));
    expect(handled).toBe(true);
    return res;
  }
  function stubMint(response: Response) {
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("returns 503 without leaking env names when the server has no vendor key", async () => {
    const res = await post(authed, {});
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual(expect.objectContaining({ code: "VOICE_NOT_CONFIGURED" }));
    expect(JSON.stringify(res.body)).not.toContain("XAI_API_KEY");
  });

  it("mints an ephemeral token from XAI_API_KEY when REST auth is on", async () => {
    process.env.XAI_API_KEY = "sk-server";
    stubMint(new Response(JSON.stringify({ value: "ephemeral" }), { status: 200 }));
    const res = await post(authed, { provider: "xai" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ token: "ephemeral", provider: "xai", model: "grok-voice-latest" }));
  });

  it("refuses to mint when auth is disabled", async () => {
    process.env.XAI_API_KEY = "sk-server";
    const fetchMock = stubMint(new Response(JSON.stringify({ value: "ephemeral" }), { status: 200 }));
    const res = await post({ maxBodyBytes: 2_000_000, authDisabled: true }, { provider: "xai" });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({ code: "VOICE_AUTH_REQUIRED" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to mint when no auth token is configured", async () => {
    process.env.XAI_API_KEY = "sk-server";
    const fetchMock = stubMint(new Response(JSON.stringify({ value: "ephemeral" }), { status: 200 }));
    const res = await post({ maxBodyBytes: 2_000_000 }, {});
    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mints with auth disabled only when voice.allowUnauthenticated is set", async () => {
    process.env.XAI_API_KEY = "sk-server";
    stubMint(new Response(JSON.stringify({ value: "ephemeral" }), { status: 200 }));
    const res = await post(
      { maxBodyBytes: 2_000_000, authDisabled: true, voice: { allowUnauthenticated: true } },
      { provider: "xai" },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ token: "ephemeral" }));
  });

  it("rejects a model outside the allowlist before calling upstream", async () => {
    process.env.XAI_API_KEY = "sk-server";
    const fetchMock = stubMint(new Response(JSON.stringify({ value: "ephemeral" }), { status: 200 }));
    const res = await post(authed, { provider: "xai", model: "grok-expensive-unreleased" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ code: "VOICE_MODEL_NOT_ALLOWED" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors a configured model allowlist", async () => {
    process.env.OPENAI_API_KEY = "sk-server";
    stubMint(new Response(JSON.stringify({ client_secret: { value: "eph" } }), { status: 200 }));
    const cfg = { ...authed, voice: { allowedModels: ["gpt-realtime"] } };
    expect((await post(cfg, { provider: "openai", model: "gpt-realtime" })).statusCode).toBe(200);
    expect((await post(cfg, { provider: "openai" })).statusCode).toBe(400);
  });

  it("rejects unknown providers", async () => {
    process.env.XAI_API_KEY = "sk-server";
    const res = await post(authed, { provider: "evil" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ code: "VOICE_PROVIDER_NOT_ALLOWED" }));
  });

  it("returns a generic error and does not leak the upstream body", async () => {
    process.env.XAI_API_KEY = "sk-server";
    stubMint(new Response("org-123 quota exceeded for key sk-server-abc; internal trace xyz", { status: 429 }));
    const res = await post(authed, { provider: "xai" });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: "Failed to mint a voice session token.", code: "VOICE_MINT_FAILED" });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("org-123");
    expect(text).not.toContain("429");
  });
});
