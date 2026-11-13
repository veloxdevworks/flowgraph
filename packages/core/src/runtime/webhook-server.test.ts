import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import { compileGraph } from "../compiler.js";
import type { GraphSpec } from "@flowgraph/spec";
import {
  closeWebhookServers,
  buildWebhookUrl,
  ensureWebhookServer,
  getWebhookRoute,
  registerWebhookRoute,
  unregisterWebhookRoute,
  DEFAULT_WEBHOOK_PORT,
} from "./webhook-server.js";

function webhookWaitGraph(
  extra: Record<string, unknown> = {},
  runtimeExtra: Record<string, unknown> = {},
): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "webhook-ingress" },
    state: { channels: { approval: { type: "object" } } },
    nodes: [
      {
        id: "await-approval",
        type: "wait",
        with: {
          webhook: true,
          output: { to: "approval" },
          ...extra,
        },
      },
    ],
    edges: [
      { from: "START", to: "await-approval" },
      { from: "await-approval", to: "END" },
    ],
    runtime: {
      checkpoint: { enabled: true, backend: "memory" },
      webhookServer: { port: 0 },
      ...runtimeExtra,
    },
  } as unknown as GraphSpec;
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// The automatic 100 Continue response confirms the server has received the
// headers and entered the handler before we send the body, without sleeps.
async function pendingPost(url: string, token?: string) {
  const body = JSON.stringify({ approved: true });
  let ready!: () => void;
  let failed!: (error: Error) => void;
  const headersReceived = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const req = http.request(url, {
    method: "POST",
    headers: {
      Expect: "100-continue",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const response = new Promise<number>((resolve, reject) => {
    req.once("response", (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode!));
      res.once("error", reject);
    });
    req.once("error", (error) => {
      failed(error);
      reject(error);
    });
  });
  // Keep an early socket error handled even while waiting for the headers.
  void response.catch(() => {});
  req.once("continue", ready);
  req.setTimeout(2_000, () => req.destroy(new Error("Webhook test request timed out")));
  req.flushHeaders();
  await headersReceived;
  return { finish: () => req.end(body), response, close: () => req.destroy() };
}

describe("webhook HTTP ingress", () => {
  afterEach(async () => {
    await closeWebhookServers();
  });

  it("attaches a real webhookUrl and POST resumes the run", async () => {
    const compiled = await compileGraph(webhookWaitGraph(), {});
    const r1 = await compiled.run({ threadId: "ingress-1", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");

    const data = (r1.interrupts?.[0]?.payload as { data?: { webhookUrl?: string } })?.data;
    expect(data?.webhookUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/webhooks\/ingress-1\/await-approval$/,
    );

    const getRes = await fetch(data!.webhookUrl!);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toMatchObject({ waiting: true, threadId: "ingress-1" });

    const post = await postJson(data!.webhookUrl!, { approved: true });
    expect(post.status).toBe(200);
    expect(post.json).toEqual({ status: "completed" });

    // Route is one-shot
    expect(getWebhookRoute("ingress-1")).toBeUndefined();

    const snap = await compiled.getState("ingress-1");
    expect(snap?.values["approval"]).toEqual({ approved: true });
  });

  it("POST with a falsy JSON body resumes the run with that value", async () => {
    const compiled = await compileGraph(webhookWaitGraph(), {});
    for (const [i, body] of [false, null, 0].entries()) {
      const threadId = `ingress-falsy-${i}`;
      const r1 = await compiled.run({ threadId, onInterrupt: "fail" });
      const url = (r1.interrupts?.[0]?.payload as { data?: { webhookUrl?: string } })?.data?.webhookUrl;
      const post = await postJson(url!, body);
      expect(post.status).toBe(200);
      expect(post.json).toEqual({ status: "completed" });
      expect((await compiled.getState(threadId))?.values["approval"]).toEqual({ value: body });
    }
  });

  it("enforces each graph's webhook token on its own routes only", async () => {
    const secured = await compileGraph(
      webhookWaitGraph({}, { webhookServer: { port: 0, token: "s3cret" } }),
      {},
    );
    const open = await compileGraph(webhookWaitGraph(), {});
    const r1 = await secured.run({ threadId: "tok-secured", onInterrupt: "fail" });
    const r2 = await open.run({ threadId: "tok-open", onInterrupt: "fail" });
    const url1 = (r1.interrupts?.[0]?.payload as { data?: { webhookUrl?: string } })?.data
      ?.webhookUrl;
    const url2 = (r2.interrupts?.[0]?.payload as { data?: { webhookUrl?: string } })?.data
      ?.webhookUrl;

    expect((await fetch(url1!)).status).toBe(401);
    expect((await postJson(url1!, { approved: true })).status).toBe(401);
    const wrong = await fetch(url1!, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
    const ok = await fetch(url1!, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer s3cret" },
      body: JSON.stringify({ approved: true }),
    });
    expect(ok.status).toBe(200);

    // A tokenless graph is unaffected by another graph's token.
    expect((await postJson(url2!, { approved: false })).status).toBe(200);
  });

  it("returns 422 when schema validation fails on POST", async () => {
    const compiled = await compileGraph(
      webhookWaitGraph({
        webhook: {
          schema: {
            type: "object",
            required: ["approved"],
            properties: { approved: { type: "boolean" } },
          },
        },
      }),
      {},
    );
    const r1 = await compiled.run({ threadId: "ingress-422", onInterrupt: "fail" });
    const url = (r1.interrupts?.[0]?.payload as { data?: { webhookUrl?: string } })?.data
      ?.webhookUrl;
    expect(url).toBeTruthy();

    const post = await postJson(url!, { status: "pending" });
    expect(post.status).toBe(422);
    expect((post.json as { message?: string }).message).toContain("approved");
  });

  it("returns 404 for unknown thread", async () => {
    const info = await ensureWebhookServer({ port: 0 });
    const res = await fetch(`http://${info.host}:${info.port}/webhooks/no-such-thread/node`);
    expect(res.status).toBe(404);
  });

  it.each(["%", "%ZZ", "%E0%A4%A"])(
    "rejects malformed path encoding %s and keeps the pending route usable",
    async (encoded) => {
      const { host, port } = await ensureWebhookServer({ port: 0 });
      const base = `http://${host}:${port}/webhooks`;
      const resume = vi.fn(async () => ({ status: "completed" }));
      const done = registerWebhookRoute({ threadId: "valid", nodeId: "gate", resume });

      for (const route of [`${encoded}/gate`, `valid/${encoded}`]) {
        for (const method of ["GET", "POST"]) {
          const response = await fetch(`${base}/${route}`, { method });
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({ error: "invalid_path" });
        }
      }
      expect(resume).not.toHaveBeenCalled();
      expect((await fetch(`${base}/valid/gate`)).status).toBe(200);
      expect((await postJson(`${base}/valid/gate`, { approved: true })).status).toBe(200);
      expect(await done).toEqual({ status: "completed" });
      expect(resume).toHaveBeenCalledOnce();
    },
  );

  it("claims a route only once when two POST bodies overlap", async () => {
    const { host, port } = await ensureWebhookServer({ port: 0 });
    const resume = vi.fn(async () => ({ status: "completed" }));
    const done = registerWebhookRoute({ threadId: "overlap", nodeId: "gate", resume });
    const url = `http://${host}:${port}/webhooks/overlap/gate`;
    const first = await pendingPost(url);
    const second = await pendingPost(url);
    try {
      first.finish();
      second.finish();
      expect((await Promise.all([first.response, second.response])).sort()).toEqual([200, 404]);
      expect(resume).toHaveBeenCalledOnce();
      expect(await done).toEqual({ status: "completed" });
      expect(getWebhookRoute("overlap")).toBeUndefined();
    } finally {
      first.close();
      second.close();
    }
  });

  it("still accepts valid percent-encoded thread and node ids", async () => {
    const { host, port } = await ensureWebhookServer({ port: 0 });
    const threadId = "run/with % and spaces";
    const nodeId = "gate/✓";
    const resume = vi.fn(async () => ({ status: "completed" }));
    const done = registerWebhookRoute({ threadId, nodeId, resume });
    const url = buildWebhookUrl(host, port, threadId, nodeId);
    expect((await fetch(`${url}?source=test`)).status).toBe(200);
    expect((await postJson(url, {})).status).toBe(200);
    expect(await done).toEqual({ status: "completed" });
    expect(resume).toHaveBeenCalledOnce();
  });

  it("does not resume a cancelled route after reading a delayed body", async () => {
    const { host, port } = await ensureWebhookServer({ port: 0 });
    const resume = vi.fn(async () => ({ status: "completed" }));
    const done = registerWebhookRoute({ threadId: "cancelled", nodeId: "gate", resume });
    const pending = await pendingPost(`http://${host}:${port}/webhooks/cancelled/gate`);
    try {
      unregisterWebhookRoute("cancelled");
      pending.finish();
      expect(await pending.response).toBe(404);
      expect(resume).not.toHaveBeenCalled();
      expect(await done).toEqual({ status: "cancelled" });
    } finally {
      pending.close();
    }
  });

  it("preserves a replacement route when an old authenticated POST body finishes", async () => {
    const { host, port } = await ensureWebhookServer({ port: 0 });
    const original = vi.fn(async () => ({ status: "completed" }));
    const replacement = vi.fn(async () => ({ status: "completed" }));
    const done = registerWebhookRoute({
      threadId: "replaced",
      nodeId: "gate",
      token: "old",
      resume: original,
    });
    const url = `http://${host}:${port}/webhooks/replaced/gate`;
    const pending = await pendingPost(url, "old");
    try {
      const next = registerWebhookRoute({
        threadId: "replaced",
        nodeId: "gate",
        token: "new",
        resume: replacement,
      });
      pending.finish();
      expect(await pending.response).toBe(404);
      expect(original).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
      expect(await done).toEqual({ status: "cancelled" });
      expect(getWebhookRoute("replaced")?.resume).toBe(replacement);
      const valid = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer new" },
        body: "{}",
      });
      expect(valid.status).toBe(200);
      expect(await next).toEqual({ status: "completed" });
      expect(replacement).toHaveBeenCalledOnce();
    } finally {
      pending.close();
    }
  });

  it("keeps the route available after invalid JSON", async () => {
    const { host, port } = await ensureWebhookServer({ port: 0 });
    const resume = vi.fn(async () => ({ status: "completed" }));
    const done = registerWebhookRoute({ threadId: "invalid-json", nodeId: "gate", resume });
    const url = `http://${host}:${port}/webhooks/invalid-json/gate`;
    const invalid = await fetch(url, { method: "POST", body: "{broken" });
    expect(invalid.status).toBe(400);
    expect(resume).not.toHaveBeenCalled();
    expect((await postJson(url, {})).status).toBe(200);
    expect(await done).toEqual({ status: "completed" });
    expect(resume).toHaveBeenCalledOnce();
  });

  it("falls back to an ephemeral port when preferred port is in use", async () => {
    const blocker = await new Promise<http.Server>((resolve, reject) => {
      const s = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end("busy");
      });
      s.once("error", reject);
      s.listen(DEFAULT_WEBHOOK_PORT, "127.0.0.1", () => resolve(s));
    });

    try {
      const info = await ensureWebhookServer({ port: DEFAULT_WEBHOOK_PORT });
      expect(info.port).not.toBe(DEFAULT_WEBHOOK_PORT);
      expect(info.port).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
