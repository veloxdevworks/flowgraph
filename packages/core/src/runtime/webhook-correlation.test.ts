import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphSpec } from "@flowgraph/spec";
import { compileGraph, type RunResult } from "../compiler.js";
import { registerFunction } from "../nodes/function.js";
import { FlowgraphMemorySaver } from "../checkpoint/memory-saver.js";
import {
  closeWebhookServers,
  buildWebhookUrl,
  validateWebhookServerConfig,
  waitForWebhookResume,
  getWebhookRoute,
} from "./webhook-server.js";
import { webhookCorrelation } from "./webhook-correlation.js";
import { FileWebhookDeliveryJournal } from "./webhook-delivery-journal.js";

const secret = "local-verification-signing-key";
const envName = "FLOWGRAPH_TEST_WEBHOOK_SECRET";
let temp: string;

function graph(): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "correlation" },
    state: { channels: { received: { type: "object" }, second: { type: "object" } } },
    nodes: [
      {
        id: "gate",
        type: "wait",
        with: {
          webhook: {
            schema: { required: ["approved"], properties: { approved: { type: "boolean" } } },
          },
          output: { to: "received" },
        },
      },
    ],
    edges: [
      { from: "START", to: "gate" },
      { from: "gate", to: "END" },
    ],
    runtime: {
      checkpoint: { enabled: true, backend: "memory" },
      webhookServer: {
        port: 0,
        ingress: { id: "test", signingSecretEnv: envName, journalPath: temp },
      },
    },
  } as GraphSpec;
}

function url(result: RunResult): string {
  expect(result.status, result.error?.message).toBe("interrupted");
  return (result.interrupts![0]!.payload as { data: { webhookUrl: string } }).data.webhookUrl;
}

async function signed(
  endpoint: string,
  body: unknown,
  id = "event-1",
  extra: {
    secret?: string;
    timestamp?: number;
    headers?: Record<string, string>;
    raw?: string;
  } = {},
) {
  const raw = extra.raw ?? JSON.stringify(body);
  const timestamp = String(extra.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", extra.secret ?? secret)
    .update(`${timestamp}.${id}.${new URL(endpoint).pathname}.`)
    .update(raw)
    .digest("hex");
  const response = await fetch(endpoint, {
    method: "POST",
    body: raw,
    headers: {
      "Content-Type": "application/json",
      "x-flowgraph-delivery-id": id,
      "x-flowgraph-timestamp": timestamp,
      "x-flowgraph-signature": `sha256=${signature}`,
      ...extra.headers,
    },
  });
  return { http: response.status, body: (await response.json()) as Record<string, unknown> };
}

const envelope = (
  payload: unknown = { approved: true },
  correlation: Record<string, string> = { external: "one" },
) => ({ correlation, payload });

describe("signed correlation webhook ingress", () => {
  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "fg-correlated-"));
    vi.stubEnv(envName, secret);
  });
  afterEach(async () => {
    await closeWebhookServers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(temp, { recursive: true, force: true });
  });

  it("resolves opaque external keys without a thread id and caches completed deliveries", async () => {
    const compiled = await compileGraph(graph());
    const result = await compiled.run({
      threadId: "internal-thread",
      correlation: { external: "one", other: "two" },
    });
    const endpoint = url(result);
    const body = envelope();
    expect(await signed(endpoint, body)).toEqual({ http: 200, body: { status: "completed" } });
    expect(await signed(endpoint, body)).toEqual({
      http: 200,
      body: { status: "completed", duplicate: true },
    });
    expect(await signed(endpoint, envelope({ approved: false }))).toMatchObject({
      http: 409,
      body: { error: "delivery_conflict" },
    });
    expect((await compiled.getState("internal-thread"))?.values.received).toEqual({
      approved: true,
    });
  });

  it("does not copy callback values or downstream error details into receipts or HTTP errors", async () => {
    const sentinel = "private-callback-value-for-redaction-check";
    registerFunction("correlation-private-error", async () => {
      throw new Error(`Downstream error echoed ${sentinel}`);
    });
    const spec = graph();
    spec.nodes.push({ id: "effect", type: "function", with: { fn: "correlation-private-error" } });
    spec.edges = [
      { from: "START", to: "gate" },
      { from: "gate", to: "effect" },
      { from: "effect", to: "END" },
    ];
    const compiled = await compileGraph(spec);
    const endpoint = url(
      await compiled.run({ threadId: "private-error", correlation: { external: "one" } }),
    );
    const result = await signed(endpoint, envelope({ approved: true, privateValue: sentinel }));
    expect(result).toMatchObject({
      http: 422,
      body: {
        error: "resume_failed",
        status: "error",
        message: "Webhook resume failed; inspect the thread",
      },
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    const receipt = await new FileWebhookDeliveryJournal(temp, "test").get("event-1");
    expect(receipt?.response?.http).toBe(422);
    expect(JSON.stringify(receipt)).not.toContain(sentinel);
  });

  it("persists declarations and replays receipts after a fresh compile and listener restart", async () => {
    const checkpointer = new FlowgraphMemorySaver();
    const spec = graph();
    spec.runtime!.correlation = { external: "{{ input.external }}", defaultKey: "default" };
    spec.state!.channels.external = { type: "string" };
    const first = await compileGraph(spec, { checkpointer });
    const endpoint = url(
      await first.run({
        threadId: "durable",
        input: { external: "from-input" },
        correlation: { external: "one" },
      }),
    );
    const port = Number(new URL(endpoint).port);
    await closeWebhookServers();
    spec.runtime!.webhookServer!.port = port;
    const second = await compileGraph(spec, { checkpointer });
    expect((await second.getState("durable"))?.interrupts).toHaveLength(1);
    expect(await signed(endpoint, envelope())).toMatchObject({
      http: 200,
      body: { status: "completed" },
    });
    await closeWebhookServers();
    // No pending gate must be rehydrated in order to replay a completed receipt.
    const { ensureWebhookServer } = await import("./webhook-server.js");
    await ensureWebhookServer(spec.runtime!.webhookServer);
    expect(await signed(endpoint, envelope())).toMatchObject({
      http: 200,
      body: { duplicate: true },
    });
    const state = await second.getState("durable");
    expect(state?.values).not.toHaveProperty("__correlation");
    expect(state?.interrupts).toHaveLength(0);
  });

  it("fails closed when multiple runs match, without consuming the event id", async () => {
    const compiled = await compileGraph(graph());
    const endpoint = url(
      await compiled.run({ threadId: "one", correlation: { external: "one", unique: "a" } }),
    );
    await compiled.run({ threadId: "two", correlation: { external: "one", unique: "b" } });
    expect(await signed(endpoint, envelope())).toMatchObject({
      http: 409,
      body: { error: "ambiguous_correlation" },
    });
    expect((await compiled.getState("one"))?.interrupts).toHaveLength(1);
    expect((await compiled.getState("two"))?.interrupts).toHaveLength(1);
    expect(
      await signed(endpoint, envelope({ approved: true }, { external: "one", unique: "b" })),
    ).toMatchObject({ http: 200 });
    expect((await compiled.getState("one"))?.interrupts).toHaveLength(1);
  });

  it("isolates parallel gates and requires a selector for ambiguous gates", async () => {
    const spec = graph();
    spec.nodes.push({
      id: "another-gate",
      type: "wait",
      with: { webhook: true, output: { to: "second" } },
    });
    spec.edges = [
      { from: "START", to: ["gate", "another-gate"] },
      { from: "gate", to: "END" },
      { from: "another-gate", to: "END" },
    ];
    const compiled = await compileGraph(spec);
    const endpoint = url(
      await compiled.run({ threadId: "parallel", correlation: { external: "one" } }),
    );
    expect(await signed(endpoint, envelope())).toMatchObject({
      http: 409,
      body: { error: "ambiguous_correlation" },
    });
    expect(await signed(endpoint, { ...envelope(), nodeId: "gate" })).toMatchObject({
      http: 200,
      body: { status: "interrupted" },
    });
    expect((await compiled.getState("parallel"))?.interrupts).toHaveLength(1);
    expect(
      await signed(
        endpoint,
        { ...envelope({ finished: true }), nodeId: "another-gate" },
        "event-2",
      ),
    ).toMatchObject({ http: 200, body: { status: "completed" } });
  });

  it("merges gate-specific correlation over run declarations", async () => {
    const spec = graph();
    spec.state!.channels.key = { type: "string" };
    spec.nodes[0]!.with = {
      webhook: { correlation: { external: "{{ state.key }}", stage: "review" } },
      output: { to: "received" },
    };
    const compiled = await compileGraph(spec);
    const endpoint = url(
      await compiled.run({
        threadId: "specific",
        input: { key: "gate-key" },
        correlation: { external: "one" },
      }),
    );
    expect(await signed(endpoint, envelope({}, { external: "one" }))).toMatchObject({ http: 404 });
    expect(
      await signed(endpoint, envelope({}, { external: "gate-key", stage: "review" })),
    ).toMatchObject({ http: 200 });
  });

  it.each([
    ["wrong key", { secret: "wrong-verification-signing-key" }],
    ["old timestamp", { timestamp: Math.floor(Date.now() / 1000) - 86400 }],
    ["future timestamp", { timestamp: Math.floor(Date.now() / 1000) + 86400 }],
    ["missing signature", { headers: { "x-flowgraph-signature": "" } }],
    ["tampered delivery id", { headers: { "x-flowgraph-delivery-id": "a-different-delivery" } }],
  ])("rejects %s, logs safely, and leaves the wait retryable", async (_name, extra) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const compiled = await compileGraph(graph());
    const endpoint = url(
      await compiled.run({ threadId: "auth", correlation: { external: "one" } }),
    );
    expect(await signed(endpoint, envelope(), "event-1", extra)).toMatchObject({ http: 401 });
    expect(log).toHaveBeenCalledWith("[flowgraph] webhook authentication rejected");
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect((await compiled.getState("auth"))?.interrupts).toHaveLength(1);
    expect(await signed(endpoint, envelope())).toMatchObject({ http: 200 });
  });

  it("rejects valid JSON tampered after signing without claiming the delivery", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const compiled = await compileGraph(graph());
    const endpoint = url(
      await compiled.run({ threadId: "tampered-body", correlation: { external: "one" } }),
    );
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.event-1.${new URL(endpoint).pathname}.`)
      .update(JSON.stringify(envelope({ approved: true })))
      .digest("hex");
    expect(
      await signed(endpoint, envelope({ approved: false }), "event-1", {
        timestamp,
        headers: { "x-flowgraph-signature": `sha256=${signature}` },
      }),
    ).toMatchObject({ http: 401 });
    expect((await compiled.getState("tampered-body"))?.interrupts).toHaveLength(1);
    expect(await signed(endpoint, envelope())).toMatchObject({ http: 200 });
    expect((await compiled.getState("tampered-body"))?.values.received).toEqual({ approved: true });
  });

  it("binds signatures to the ingress pathname even when two ingresses share a key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = graph();
    const b = graph();
    a.runtime!.webhookServer!.ingress!.id = "first-integration";
    b.runtime!.webhookServer!.ingress!.id = "second-integration";
    const first = await compileGraph(a);
    const second = await compileGraph(b);
    const firstUrl = url(await first.run({ threadId: "path-a", correlation: { external: "one" } }));
    const secondUrl = url(
      await second.run({ threadId: "path-b", correlation: { external: "one" } }),
    );
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.event-1.${new URL(firstUrl).pathname}.`)
      .update(JSON.stringify(envelope()))
      .digest("hex");
    expect(
      await signed(secondUrl, envelope(), "event-1", {
        timestamp,
        headers: { "x-flowgraph-signature": `sha256=${signature}` },
      }),
    ).toMatchObject({ http: 401 });
    expect((await second.getState("path-b"))?.interrupts).toHaveLength(1);
    expect(await signed(secondUrl, envelope())).toMatchObject({ http: 200 });
    expect((await first.getState("path-a"))?.interrupts).toHaveLength(1);
    expect(await signed(firstUrl, envelope())).toMatchObject({ http: 200 });
  });

  it("enforces the optional bearer token in addition to the signature", async () => {
    const spec = graph();
    spec.runtime!.webhookServer!.token = "another-local-token";
    const compiled = await compileGraph(spec);
    const endpoint = url(
      await compiled.run({ threadId: "token", correlation: { external: "one" } }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await signed(endpoint, envelope())).toMatchObject({ http: 401 });
    expect(
      await signed(endpoint, envelope(), "event-1", {
        headers: { authorization: "Bearer another-local-token" },
      }),
    ).toMatchObject({ http: 200 });
  });

  it("reuses an ingress with an empty optional token", async () => {
    const spec = graph();
    spec.runtime!.webhookServer!.token = "";
    const compiled = await compileGraph(spec);
    const endpoint = url(
      await compiled.run({ threadId: "empty-token", correlation: { external: "one" } }),
    );
    expect((await compiled.getState("empty-token"))?.interrupts).toHaveLength(1);
    expect(await signed(endpoint, envelope())).toMatchObject({ http: 200 });
  });

  it("coordinates normal API invocations with an in-flight signed delivery", async () => {
    let entered!: () => void;
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effect = vi.fn(async () => {
      entered();
      await blocked;
      return {};
    });
    registerFunction("correlation-blocked-effect", effect);
    const spec = graph();
    spec.nodes.push({ id: "effect", type: "function", with: { fn: "correlation-blocked-effect" } });
    spec.edges = [
      { from: "START", to: "gate" },
      { from: "gate", to: "effect" },
      { from: "effect", to: "END" },
    ];
    const admissionEvents: Array<{ type: string; threadId?: string | undefined; data: unknown }> =
      [];
    const compiled = await compileGraph(spec, {
      sinks: [
        (event) => {
          admissionEvents.push(event);
        },
      ],
    });
    const endpoint = url(
      await compiled.run({ threadId: "locked", correlation: { external: "one" } }),
    );
    const callback = signed(endpoint, envelope());
    await active;
    try {
      const competing = await compiled.resume({ threadId: "locked", resume: { approved: true } });
      expect(competing.status).toBe("error");
      expect((competing.error as { code?: string })?.code).toBe("WEBHOOK_THREAD_BUSY");
      const continuing = await compiled.continueRun({ threadId: "locked" });
      expect((continuing.error as { code?: string })?.code).toBe("WEBHOOK_THREAD_BUSY");
      expect(
        admissionEvents
          .filter(
            (event) =>
              event.type === "log" &&
              (event.data as { code?: string }).code === "WEBHOOK_THREAD_BUSY",
          )
          .map((event) => event.threadId),
      ).toEqual(["locked", "locked"]);
      expect(admissionEvents.some((event) => event.type === "run.error")).toBe(false);
    } finally {
      release();
    }
    expect(await callback).toMatchObject({ http: 200, body: { status: "completed" } });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("schedules an already-due deadline after the initial durable receipt unlocks", async () => {
    const complete = FileWebhookDeliveryJournal.prototype.complete;
    vi.spyOn(FileWebhookDeliveryJournal.prototype, "complete").mockImplementation(async function (
      this: FileWebhookDeliveryJournal,
      claim,
      response,
    ) {
      // A slow fsync must not let the deadline race the invocation's own lock.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return complete.call(this, claim, response);
    });
    const spec = graph();
    spec.nodes[0]!.with = { webhook: true, timeout: "1ms", output: { to: "received" } };
    let timedOut: RunResult | undefined;
    const events: Array<{ type: string; data: unknown }> = [];
    const compiled = await compileGraph(spec, {
      onWaitTimeout: (result) => {
        timedOut = result;
      },
      sinks: [
        (event) => {
          events.push(event);
        },
      ],
    });
    expect(
      (await compiled.run({ threadId: "short-deadline", correlation: { external: "one" } })).status,
    ).toBe("interrupted");
    await vi.waitFor(() => expect(timedOut?.status).toBe("completed"), { timeout: 1500 });
    expect(timedOut?.state.received).toEqual({ timedOut: true });
    expect(events.filter((event) => event.type === "run.error")).toEqual([]);
  });

  it("restores a future signed deadline in a fresh runtime without firing the old timer", async () => {
    const spec = graph();
    spec.nodes[0]!.with = { webhook: true, timeout: "1h", output: { to: "received" } };
    spec.state!.channels.humanResult = { type: "object" };
    spec.nodes.push(
      {
        id: "external-sibling",
        type: "wait",
        with: { webhook: true, timeout: "2h", output: { to: "second" } },
      },
      {
        id: "human",
        type: "hitl",
        with: { mode: "approve", message: "Approve?", output: { to: "humanResult" } },
      },
    );
    spec.edges = [
      { from: "START", to: ["gate", "external-sibling", "human"] },
      { from: "gate", to: "END" },
      { from: "external-sibling", to: "END" },
      { from: "human", to: "END" },
    ];
    const checkpointer = new FlowgraphMemorySaver();
    let now = Date.now();
    const oldQueue: Array<{ fn: () => void; delay: number }> = [];
    const newQueue: Array<{ fn: () => void; delay: number }> = [];
    const schedule = (queue: typeof oldQueue) => (fn: () => void, delay: number) => {
      queue.push({ fn, delay });
      return { unref() {} };
    };
    const oldTimeout = vi.fn();
    const original = await compileGraph(spec, {
      checkpointer,
      now: () => now,
      scheduleTimeout: schedule(oldQueue),
      onWaitTimeout: oldTimeout,
    });
    const initial = await original.run({
      threadId: "future-recovery",
      correlation: { external: "one" },
    });
    expect(initial.status).toBe("interrupted");
    expect(oldQueue).toHaveLength(1);
    await closeWebhookServers();
    let timedOut: RunResult | undefined;
    const restored = await compileGraph(spec, {
      checkpointer,
      now: () => now,
      scheduleTimeout: schedule(newQueue),
      onWaitTimeout: (result) => {
        timedOut = result;
      },
    });
    await restored.getState("future-recovery", { applyWaitTimeouts: false });
    expect(newQueue).toHaveLength(0);
    const waiting = await restored.getState("future-recovery");
    expect(waiting?.interrupts).toHaveLength(3);
    expect(newQueue).toHaveLength(1);
    expect(newQueue[0]!.delay).toBeGreaterThan(0);
    const firstDeadline = Math.min(
      ...initial
        .interrupts!.map((interrupt) => Date.parse(interrupt.deadlineAt ?? ""))
        .filter(Number.isFinite),
    );
    now = firstDeadline + 1;
    newQueue.shift()!.fn();
    await vi.waitFor(() => expect(timedOut?.status).toBe("interrupted"), { timeout: 1500 });
    expect(timedOut?.state.received).toEqual({ timedOut: true });
    expect(timedOut?.state.second).toBeNull();
    expect(timedOut?.state.humanResult).toBeNull();
    expect(timedOut?.interrupts).toHaveLength(2);
    expect(oldTimeout).not.toHaveBeenCalled();
    expect(newQueue).toHaveLength(1);
  });

  it("attributes wait-timeout observer errors to the affected thread", async () => {
    const spec = graph();
    spec.nodes[0]!.with = { webhook: true, timeout: "1ms", output: { to: "received" } };
    const failures: Array<{ threadId?: string | undefined; data: unknown }> = [];
    const compiled = await compileGraph(spec, {
      onWaitTimeout: () => {
        throw new Error("verification observer failed");
      },
      sinks: [
        (event) => {
          if (event.type === "run.error") failures.push(event);
        },
      ],
    });
    expect(
      (await compiled.run({ threadId: "timeout-observer", correlation: { external: "one" } }))
        .status,
    ).toBe("interrupted");
    await vi.waitFor(() => expect(failures).toHaveLength(1), { timeout: 1500 });
    expect(failures[0]?.threadId).toBe("timeout-observer");
    expect(failures[0]?.data).toMatchObject({
      message: "onWaitTimeout callback failed: verification observer failed",
    });
  });

  it("expires an overdue sibling after HTTP delivery unlocks without answering a human gate", async () => {
    let entered!: () => void;
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const complete = FileWebhookDeliveryJournal.prototype.complete;
    vi.spyOn(FileWebhookDeliveryJournal.prototype, "complete").mockImplementation(async function (
      this: FileWebhookDeliveryJournal,
      claim,
      response,
    ) {
      if (claim.receipt.eventId === "event-1") {
        entered();
        await blocked;
      }
      return complete.call(this, claim, response);
    });
    const spec = graph();
    spec.state!.channels.humanResult = { type: "object" };
    spec.nodes.push(
      {
        id: "external-sibling",
        type: "wait",
        with: { webhook: true, timeout: "1h", output: { to: "second" } },
      },
      {
        id: "human",
        type: "hitl",
        with: { mode: "approve", message: "Approve?", output: { to: "humanResult" } },
      },
    );
    spec.edges = [
      { from: "START", to: ["gate", "external-sibling", "human"] },
      { from: "gate", to: "END" },
      { from: "external-sibling", to: "END" },
      { from: "human", to: "END" },
    ];
    let timedOut: RunResult | undefined;
    const compiled = await compileGraph(spec, {
      onWaitTimeout: (result) => {
        timedOut = result;
      },
    });
    const endpoint = url(
      await compiled.run({ threadId: "overdue-sibling", correlation: { external: "one" } }),
    );
    const callback = signed(endpoint, { ...envelope(), nodeId: "gate" });
    await active;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 3_600_000);
    try {
      release();
      expect(await callback).toMatchObject({ http: 200, body: { status: "interrupted" } });
      await vi.waitFor(() => expect(timedOut?.status).toBe("interrupted"), { timeout: 1500 });
      expect(timedOut?.state.second).toEqual({ timedOut: true });
      expect(timedOut?.state.received).toEqual({ approved: true });
      expect(timedOut?.state.humanResult).toBeNull();
      expect(timedOut?.interrupts).toHaveLength(1);
      expect(
        (timedOut?.interrupts?.[0]?.payload as { data: { __nodeId: string } }).data.__nodeId,
      ).toBe("human");
    } finally {
      clock.mockRestore();
      release();
    }
    expect(
      (await compiled.resume({ threadId: "overdue-sibling", resume: { approved: true } })).status,
    ).toBe("completed");
  });

  it("state inspection expires only due ids and preserves a sibling callback and waiter", async () => {
    const spec = graph();
    spec.nodes[0]!.with = { webhook: true, timeout: "1h", output: { to: "received" } };
    spec.state!.channels.humanResult = { type: "object" };
    spec.nodes.push(
      { id: "external-sibling", type: "wait", with: { webhook: true, output: { to: "second" } } },
      {
        id: "human",
        type: "hitl",
        with: { mode: "approve", message: "Approve?", output: { to: "humanResult" } },
      },
    );
    spec.edges = [
      { from: "START", to: ["gate", "external-sibling", "human"] },
      { from: "gate", to: "END" },
      { from: "external-sibling", to: "END" },
      { from: "human", to: "END" },
    ];
    const compiled = await compileGraph(spec);
    const initial = await compiled.run({
      threadId: "inspect-expiry",
      correlation: { external: "one" },
    });
    const endpoint = url(initial);
    const sibling = initial.interrupts!.find(
      (interrupt) =>
        (interrupt.payload as { data: { __nodeId: string } }).data.__nodeId === "external-sibling",
    )!;
    const expired = initial.interrupts!.find(
      (interrupt) => (interrupt.payload as { data: { __nodeId: string } }).data.__nodeId === "gate",
    )!;
    const waiter = waitForWebhookResume("inspect-expiry", "external-sibling", sibling.id);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 3_600_000);
    try {
      const state = await compiled.getState("inspect-expiry");
      expect(state?.values.received).toEqual({ timedOut: true });
      expect(state?.values.second).toBeNull();
      expect(state?.values.humanResult).toBeNull();
      expect(state?.interrupts).toHaveLength(2);
      expect(getWebhookRoute("inspect-expiry", "gate", expired.id)).toBeUndefined();
      expect(waitForWebhookResume("inspect-expiry", "external-sibling", sibling.id)).toBe(waiter);
    } finally {
      clock.mockRestore();
    }
    expect(
      await signed(endpoint, { ...envelope({ finished: true }), nodeId: "external-sibling" }),
    ).toMatchObject({ http: 200, body: { status: "interrupted" } });
    expect(await waiter).toEqual({ status: "interrupted" });
    expect(
      (await compiled.resume({ threadId: "inspect-expiry", resume: { approved: true } })).status,
    ).toBe("completed");
  });

  it("a manual targeted answer keeps its payload while only overdue siblings time out", async () => {
    const spec = graph();
    spec.nodes[0]!.with = { webhook: true, timeout: "1h", output: { to: "received" } };
    spec.state!.channels.humanResult = { type: "object" };
    spec.nodes.push(
      { id: "external-sibling", type: "wait", with: { webhook: true, output: { to: "second" } } },
      {
        id: "human",
        type: "hitl",
        with: { mode: "approve", message: "Approve?", output: { to: "humanResult" } },
      },
    );
    spec.edges = [
      { from: "START", to: ["gate", "external-sibling", "human"] },
      { from: "gate", to: "END" },
      { from: "external-sibling", to: "END" },
      { from: "human", to: "END" },
    ];
    const compiled = await compileGraph(spec);
    const initial = await compiled.run({
      threadId: "manual-expiry",
      correlation: { external: "one" },
    });
    url(initial);
    const sibling = initial.interrupts!.find(
      (interrupt) =>
        (interrupt.payload as { data: { __nodeId: string } }).data.__nodeId === "external-sibling",
    )!;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 3_600_000);
    try {
      const result = await compiled.resume({
        threadId: "manual-expiry",
        resume: { [sibling.id]: { finished: true } },
      });
      expect(result.status).toBe("interrupted");
      expect(result.state.received).toEqual({ timedOut: true });
      expect(result.state.second).toEqual({ finished: true });
      expect(result.state.humanResult).toBeNull();
      expect(result.interrupts).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
    expect(
      (await compiled.resume({ threadId: "manual-expiry", resume: { approved: true } })).status,
    ).toBe("completed");
  });

  it("allows a corrected callback using the same id after schema or envelope rejection", async () => {
    const compiled = await compileGraph(graph());
    const endpoint = url(
      await compiled.run({ threadId: "retry", correlation: { external: "one" } }),
    );
    expect(await signed(endpoint, {}, "event-1")).toMatchObject({ http: 400 });
    expect(await signed(endpoint, envelope({ approved: "wrong" }))).toMatchObject({
      http: 422,
      body: { error: "invalid_payload" },
    });
    expect(await signed(endpoint, envelope())).toMatchObject({ http: 200 });
  });

  it("never applies a duplicate delivery to a later sequential gate", async () => {
    const count = vi.fn(async () => ({}));
    registerFunction("correlation-counter", count);
    const spec = graph();
    spec.nodes.push({ id: "effect", type: "function", with: { fn: "correlation-counter" } });
    spec.nodes.push({
      id: "next-gate",
      type: "wait",
      with: { webhook: true, output: { to: "second" } },
    });
    spec.edges = [
      { from: "START", to: "gate" },
      { from: "gate", to: "effect" },
      { from: "effect", to: "next-gate" },
      { from: "next-gate", to: "END" },
    ];
    const compiled = await compileGraph(spec);
    const endpoint = url(
      await compiled.run({ threadId: "sequential", correlation: { external: "one" } }),
    );
    const body = envelope();
    const results = await Promise.all(Array.from({ length: 8 }, () => signed(endpoint, body)));
    expect(results.filter((r) => r.http === 200).length).toBeGreaterThan(0);
    expect(results.every((r) => r.http === 200 || r.http === 409)).toBe(true);
    expect(count).toHaveBeenCalledTimes(1);
    expect(await signed(endpoint, body)).toMatchObject({
      http: 200,
      body: { duplicate: true, status: "interrupted" },
    });
    expect((await compiled.getState("sequential"))?.interrupts).toHaveLength(1);
    expect(await signed(endpoint, envelope({ second: true }), "event-2")).toMatchObject({
      http: 200,
      body: { status: "completed" },
    });
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("does not bypass signatures through the legacy raw-payload URL", async () => {
    const compiled = await compileGraph(graph());
    const initial = await compiled.run({ threadId: "legacy", correlation: { external: "one" } });
    const endpoint = url(initial);
    const legacy = buildWebhookUrl(
      "127.0.0.1",
      Number(new URL(endpoint).port),
      "legacy",
      "gate",
      initial.interrupts![0]!.id,
    );
    expect((await fetch(legacy, { method: "POST", body: '{"approved":true}' })).status).toBe(410);
    expect(await signed(endpoint, envelope())).toMatchObject({ http: 200 });
  });

  it("fails closed for a durable claim with an unknown outcome", async () => {
    const compiled = await compileGraph(graph());
    const endpoint = url(
      await compiled.run({ threadId: "in-doubt", correlation: { external: "one" } }),
    );
    const { createHash } = await import("node:crypto");
    const fingerprint = createHash("sha256")
      .update(new URL(endpoint).pathname)
      .update("\0")
      .update(JSON.stringify(envelope()))
      .digest("hex");
    const journal = new FileWebhookDeliveryJournal(temp, "test");
    expect((await journal.claim("event-1", fingerprint, { threadId: "in-doubt" })).kind).toBe(
      "claimed",
    );
    expect(await signed(endpoint, envelope())).toMatchObject({
      http: 409,
      body: { error: "delivery_in_doubt" },
    });
    expect(await signed(endpoint, envelope(), "event-2")).toMatchObject({
      http: 409,
      body: { error: "thread_busy" },
    });
    expect((await compiled.getState("in-doubt"))?.interrupts).toHaveLength(1);
  });

  it("refuses missing signing configuration and unauthenticated public listeners before running", async () => {
    vi.stubEnv(envName, "");
    await expect(compileGraph(graph())).rejects.toThrow("at least 16 bytes");
    expect(() => validateWebhookServerConfig({ host: "0.0.0.0" })).toThrow("requires a token");
    expect(() => validateWebhookServerConfig({ host: "0.0.0.0", token: "test" })).not.toThrow();
    expect(() => validateWebhookServerConfig({ host: "::1" })).not.toThrow();
  });

  it("reports a missing correlation instead of creating an unreachable signed wait", async () => {
    const compiled = await compileGraph(graph());
    const result = await compiled.run({ threadId: "no-correlation" });
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("between 1 and 32 pairs");
  });

  it("fails closed when the same saved gate is rebound to a different ingress", async () => {
    const checkpointer = new FlowgraphMemorySaver();
    const spec = graph();
    const original = await compileGraph(spec, { checkpointer });
    const endpoint = url(
      await original.run({ threadId: "scope", correlation: { external: "one" } }),
    );
    const different = graph();
    different.runtime!.webhookServer!.ingress!.id = "different";
    const other = await compileGraph(different, { checkpointer });
    await expect(other.getState("scope")).rejects.toThrow(
      "already bound to another listener/ingress",
    );
    expect(await signed(endpoint, envelope())).toMatchObject({ http: 200 });
  });

  it("validates correlation pairs and accepts opaque keys safely", () => {
    expect(
      webhookCorrelation(JSON.parse('{"__proto__":"opaque","project.id":"123"}'), true),
    ).toEqual(JSON.parse('{"__proto__":"opaque","project.id":"123"}'));
    for (const bad of [null, [], {}, { key: 123 }, { key: "" }])
      expect(() => webhookCorrelation(bad, true)).toThrow();
  });
});
