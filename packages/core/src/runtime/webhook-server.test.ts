import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { compileGraph } from "../compiler.js";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import {
  closeWebhookServers,
  ensureWebhookServer,
  getWebhookRoute,
  DEFAULT_WEBHOOK_PORT,
} from "./webhook-server.js";

function webhookWaitGraph(extra: Record<string, unknown> = {}, runtimeExtra: Record<string, unknown> = {}): GraphSpec {
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

describe("webhook HTTP ingress", () => {
  afterEach(async () => {
    await closeWebhookServers();
  });

  it("attaches a real webhookUrl and POST resumes the run", async () => {
    const compiled = await compileGraph(webhookWaitGraph(), {});
    const r1 = await compiled.run({ threadId: "ingress-1", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");

    const data = (r1.interrupts?.[0]?.payload as { data?: { webhookUrl?: string } })?.data;
    expect(data?.webhookUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/webhooks\/ingress-1\/await-approval$/);

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
    const url = (r1.interrupts?.[0]?.payload as { data?: { webhookUrl?: string } })?.data?.webhookUrl;
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
