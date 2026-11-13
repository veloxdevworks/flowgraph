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
  waitForWebhookResume,
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

function parallelWebhookGraph(human = false): GraphSpec {
  const spec = webhookWaitGraph();
  spec.state!.channels!["second"] = { type: "object" };
  spec.nodes.push({
    id: "second-gate",
    type: human ? "hitl" : "wait",
    with: human
      ? { mode: "approve", message: "Approve?", output: { to: "second" } }
      : {
          webhook: { schema: { required: ["answer"], properties: { answer: { type: "string" } } } },
          output: { to: "second" },
        },
  });
  spec.edges = [
    { from: "START", to: ["await-approval", "second-gate"] },
    { from: "await-approval", to: "END" },
    { from: "second-gate", to: "END" },
  ];
  return spec;
}

function callbackUrl(interrupt: { payload?: unknown }): string {
  return (interrupt.payload as { data: { webhookUrl: string } }).data.webhookUrl;
}

function interruptNode(interrupt: { payload?: unknown }): string {
  return (interrupt.payload as { data: { __nodeId: string } }).data.__nodeId;
}

// The automatic 100 Continue response confirms the server has received the
// headers and entered the handler before we send the body, without sleeps.
async function pendingPost(url: string, token?: string, payload: unknown = { approved: true }) {
  const body = JSON.stringify(payload);
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

  it.each([false, true])(
    "keeps sibling gates waiting when answered in reverse order: %s",
    async (reverse) => {
      const compiled = await compileGraph(parallelWebhookGraph(), {});
      const result = await compiled.run({ threadId: "parallel", onInterrupt: "fail" });
      expect(result.interrupts).toHaveLength(2);
      const gates = [...result.interrupts!].sort((a, b) =>
        interruptNode(a).localeCompare(interruptNode(b)),
      );
      if (reverse) gates.reverse();
      const [first, second] = gates;
      const firstUrl = callbackUrl(first!);
      const secondUrl = callbackUrl(second!);
      expect(firstUrl).not.toBe(secondUrl);
      expect((await fetch(firstUrl)).status).toBe(200);
      expect((await fetch(secondUrl)).status).toBe(200);
      expect(await postJson(firstUrl, { answer: "first" })).toEqual({
        status: 200,
        json: { status: "interrupted" },
      });
      const snapshot = await compiled.getState("parallel");
      expect(snapshot?.interrupts).toHaveLength(1);
      expect(snapshot?.interrupts[0]?.id).toBe(second!.id);
      expect(callbackUrl(snapshot!.interrupts[0]!)).toBe(secondUrl);
      const firstChannel = interruptNode(first!) === "await-approval" ? "approval" : "second";
      const secondChannel = firstChannel === "approval" ? "second" : "approval";
      expect(snapshot?.values[firstChannel]).toEqual({ answer: "first" });
      expect(snapshot?.values[secondChannel]).toBeNull();
      expect((await postJson(firstUrl, { answer: "duplicate" })).status).toBe(404);
      expect((await fetch(secondUrl)).status).toBe(200);
      if (secondChannel === "second")
        expect((await postJson(secondUrl, { answer: false })).status).toBe(422);
      expect(await postJson(secondUrl, { answer: "second" })).toEqual({
        status: 200,
        json: { status: "completed" },
      });
      expect((await compiled.getState("parallel"))?.values).toMatchObject({
        [firstChannel]: { answer: "first" },
        [secondChannel]: { answer: "second" },
      });
    },
  );

  it("serializes simultaneous callbacks for different interrupts in one thread", async () => {
    const compiled = await compileGraph(parallelWebhookGraph(), {});
    const first = await compiled.run({ threadId: "parallel-posts", onInterrupt: "fail" });
    const gates = first.interrupts!;
    const replies = await Promise.all(
      gates.map((gate, i) => postJson(callbackUrl(gate), { answer: `answer-${i}` })),
    );
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    expect(replies.map((reply) => (reply.json as { status: string }).status).sort()).toEqual([
      "completed",
      "interrupted",
    ]);
    const snapshot = await compiled.getState("parallel-posts");
    expect(snapshot?.interrupts).toHaveLength(0);
    for (const [i, gate] of gates.entries()) {
      expect(
        snapshot?.values[interruptNode(gate) === "await-approval" ? "approval" : "second"],
      ).toEqual({ answer: `answer-${i}` });
    }
  });

  it("does not answer a parallel human gate with the webhook's payload", async () => {
    const compiled = await compileGraph(parallelWebhookGraph(true), {});
    const first = await compiled.run({ threadId: "parallel-human", onInterrupt: "fail" });
    const webhook = first.interrupts!.find((gate) => interruptNode(gate) === "await-approval")!;
    const human = first.interrupts!.find((gate) => gate.kind === "approval")!;
    expect(await postJson(callbackUrl(webhook), { answer: "external" })).toEqual({
      status: 200,
      json: { status: "interrupted" },
    });
    const snapshot = await compiled.getState("parallel-human");
    expect(snapshot?.interrupts.map((gate) => gate.id)).toEqual([human.id]);
    expect(snapshot?.values["second"]).toBeNull();
    expect(
      (
        await compiled.resume({
          threadId: "parallel-human",
          resume: { [human.id]: { approved: false } },
          onInterrupt: "fail",
        })
      ).status,
    ).toBe("completed");
  });

  it("isolates equally named gates in parallel subgraphs", async () => {
    const spec = parallelWebhookGraph();
    spec.nodes = ["a", "b"].map((name, i) => ({
      id: `branch-${name}`,
      type: "subgraph",
      spec: {
        metadata: { name: `child-${name}` },
        state: { channels: { answer: { type: "object" } } },
        nodes: [
          { id: "shared-gate", type: "wait", with: { webhook: true, output: { to: "answer" } } },
        ],
        edges: [
          { from: "START", to: "shared-gate" },
          { from: "shared-gate", to: "END" },
        ],
      },
      with: { output: { to: i === 0 ? "approval" : "second" } },
    })) as unknown as GraphSpec["nodes"];
    spec.edges = [
      { from: "START", to: ["branch-a", "branch-b"] },
      { from: "branch-a", to: "END" },
      { from: "branch-b", to: "END" },
    ];
    const compiled = await compileGraph(spec, {});
    const first = await compiled.run({ threadId: "nested-gates", onInterrupt: "fail" });
    expect(first.interrupts).toHaveLength(2);
    const [a, b] = first.interrupts!;
    expect(interruptNode(a!)).toBe("shared-gate");
    expect(interruptNode(b!)).toBe("shared-gate");
    expect(callbackUrl(a!)).not.toBe(callbackUrl(b!));
    const legacy = callbackUrl(a!).slice(0, callbackUrl(a!).lastIndexOf("/"));
    expect((await postJson(legacy, { answer: "ambiguous" })).status).toBe(409);
    expect(await postJson(callbackUrl(a!), { answer: "a" })).toEqual({
      status: 200,
      json: { status: "interrupted" },
    });
    const snapshot = await compiled.getState("nested-gates");
    expect(snapshot?.interrupts.map((gate) => gate.id)).toEqual([b!.id]);
    expect((await postJson(callbackUrl(a!), { answer: "duplicate" })).status).toBe(404);
    expect(await postJson(callbackUrl(b!), { answer: "b" })).toEqual({
      status: 200,
      json: { status: "completed" },
    });
    const values = (await compiled.getState("nested-gates"))!.values;
    expect(
      [values["approval"], values["second"]]
        .map((value) => (value as { answer: { answer: string } }).answer.answer)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("does not broadcast an overdue callback's timeout to a human sibling", async () => {
    const spec = parallelWebhookGraph(true);
    spec.nodes[0]!.with = { ...spec.nodes[0]!.with, timeout: "1h" };
    const compiled = await compileGraph(spec, {});
    const first = await compiled.run({ threadId: "overdue-callback", onInterrupt: "fail" });
    const webhook = first.interrupts!.find((gate) => interruptNode(gate) === "await-approval")!;
    const human = first.interrupts!.find((gate) => gate.kind === "approval")!;
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 7_200_000);
    try {
      expect(await postJson(callbackUrl(webhook), { answer: "late" })).toEqual({
        status: 200,
        json: { status: "interrupted" },
      });
    } finally {
      clock.mockRestore();
    }
    const snapshot = await compiled.getState("overdue-callback");
    expect(snapshot?.interrupts.map((gate) => gate.id)).toEqual([human.id]);
    expect(snapshot?.values["approval"]).toEqual({ timedOut: true });
    expect(snapshot?.values["second"]).toBeNull();
    expect(
      (
        await compiled.resume({
          threadId: "overdue-callback",
          resume: { [human.id]: false },
          onInterrupt: "fail",
        })
      ).status,
    ).toBe("completed");
  });

  it("cancels all pending routes when a parallel run is aborted", async () => {
    const compiled = await compileGraph(parallelWebhookGraph(), {});
    const controller = new AbortController();
    const first = await compiled.run({
      threadId: "abort-parallel",
      signal: controller.signal,
      onInterrupt: "fail",
    });
    const waiters = first.interrupts!.map((gate) =>
      waitForWebhookResume("abort-parallel", interruptNode(gate), gate.id),
    );
    controller.abort();
    expect(await Promise.all(waiters)).toEqual([{ status: "cancelled" }, { status: "cancelled" }]);
    for (const gate of first.interrupts!) expect((await fetch(callbackUrl(gate))).status).toBe(404);
  });

  it("attaches a real webhookUrl and POST resumes the run", async () => {
    const compiled = await compileGraph(webhookWaitGraph(), {});
    const r1 = await compiled.run({ threadId: "ingress-1", onInterrupt: "fail" });
    expect(r1.status).toBe("interrupted");

    const data = (r1.interrupts?.[0]?.payload as { data?: { webhookUrl?: string } })?.data;
    expect(data?.webhookUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/webhooks\/ingress-1\/await-approval\/[0-9a-f]{32}$/,
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
      const url = (r1.interrupts?.[0]?.payload as { data?: { webhookUrl?: string } })?.data
        ?.webhookUrl;
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

  it("rejects invalid payloads without consuming the wait, then accepts a corrected callback", async () => {
    const compiled = await compileGraph(
      webhookWaitGraph(
        {
          webhook: {
            schema: {
              type: "object",
              required: ["approved"],
              properties: { approved: { type: "boolean" } },
            },
          },
          timeout: "1h",
        },
        { webhookServer: { port: 0, token: "validation-secret" } },
      ),
      {},
    );
    const r1 = await compiled.run({ threadId: "ingress-422", onInterrupt: "fail" });
    const url = (r1.interrupts?.[0]?.payload as { data?: { webhookUrl?: string } })?.data
      ?.webhookUrl;
    expect(url).toBeTruthy();
    const original = await compiled.getState("ingress-422");
    const route = getWebhookRoute("ingress-422");
    const waiter = waitForWebhookResume("ingress-422");
    expect(waiter).not.toBeNull();
    const events: string[] = [];
    compiled.events.subscribe((e) => {
      events.push(e.type);
    });

    for (const payload of [{ status: "pending" }, { approved: "yes" }, {}, { timedOut: true }]) {
      const post = await fetch(url!, {
        method: "POST",
        headers: { Authorization: "Bearer validation-secret", "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(post.status).toBe(422);
      expect(await post.json()).toMatchObject({ error: "invalid_payload", status: "interrupted" });
      expect(getWebhookRoute("ingress-422")).toBe(route);
      expect(waitForWebhookResume("ingress-422")).toBe(waiter);
      expect(await compiled.getState("ingress-422")).toEqual(original);
      expect(
        (await fetch(url!, { headers: { Authorization: "Bearer validation-secret" } })).status,
      ).toBe(200);
    }
    expect(events).not.toContain("interrupt.resumed");
    expect(events).not.toContain("run.error");
    expect((await postJson(url!, { approved: true })).status).toBe(401);
    const corrected = await fetch(url!, {
      method: "POST",
      headers: { Authorization: "Bearer validation-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ approved: false }),
    });
    expect(corrected.status).toBe(200);
    expect(await corrected.json()).toEqual({ status: "completed" });
    expect(await waiter).toEqual({ status: "completed" });
    expect((await compiled.getState("ingress-422"))?.values["approval"]).toEqual({
      approved: false,
    });
    expect(events.filter((e) => e === "interrupt.resumed")).toHaveLength(1);
    expect(getWebhookRoute("ingress-422")).toBeUndefined();
    expect((await postJson(url!, { approved: true })).status).toBe(404);
  });

  it("returns 404 for unknown thread", async () => {
    const info = await ensureWebhookServer({ port: 0 });
    const res = await fetch(`http://${info.host}:${info.port}/webhooks/no-such-thread/node`);
    expect(res.status).toBe(404);
  });

  it.each([
    ["boolean", false],
    ["integer", 0],
    ["string", ""],
    ["null", null],
    ["array", ["item"]],
  ])("validates a normalized %s payload consistently with the wait node", async (type, value) => {
    const compiled = await compileGraph(
      webhookWaitGraph({
        webhook: {
          schema: { required: ["value"], properties: { value: { type } } },
        },
      }),
      {},
    );
    const result = await compiled.run({ threadId: "normalized", onInterrupt: "fail" });
    const url = (result.interrupts?.[0]?.payload as { data: { webhookUrl: string } }).data
      .webhookUrl;
    expect(await postJson(url, value)).toEqual({ status: 200, json: { status: "completed" } });
    expect((await compiled.getState("normalized"))?.values["approval"]).toEqual({ value });
  });

  it.each(["%", "%ZZ", "%E0%A4%A"])(
    "rejects malformed path encoding %s and keeps the pending route usable",
    async (encoded) => {
      const { host, port } = await ensureWebhookServer({ port: 0 });
      const base = `http://${host}:${port}/webhooks`;
      const resume = vi.fn(async () => ({ status: "completed" }));
      const done = registerWebhookRoute({ threadId: "valid", nodeId: "gate", resume });

      for (const route of [`${encoded}/gate`, `valid/${encoded}`, `valid/gate/${encoded}`]) {
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

  it("does not let an invalid overlapping POST consume the valid callback's route", async () => {
    const compiled = await compileGraph(
      webhookWaitGraph({
        webhook: {
          schema: { required: ["approved"], properties: { approved: { type: "boolean" } } },
        },
      }),
      {},
    );
    const result = await compiled.run({ threadId: "validation-overlap", onInterrupt: "fail" });
    const url = (result.interrupts?.[0]?.payload as { data: { webhookUrl: string } }).data
      .webhookUrl;
    const before = await compiled.getState("validation-overlap");
    const invalid = await pendingPost(url, undefined, { approved: "wrong" });
    const valid = await pendingPost(url);
    try {
      invalid.finish();
      expect(await invalid.response).toBe(422);
      expect(await compiled.getState("validation-overlap")).toEqual(before);
      valid.finish();
      expect(await valid.response).toBe(200);
      expect((await compiled.getState("validation-overlap"))?.values["approval"]).toEqual({
        approved: true,
      });
    } finally {
      invalid.close();
      valid.close();
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
