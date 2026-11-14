/** PLAT-279 + PLAT-281: signed callbacks and active/rejected progress streams. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  compileGraph,
  registerFunction,
  closeWebhookServers,
} from "../packages/core/dist/index.js";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-combined-"));
const secret = "local-combined-verification-key-not-for-production";
process.env.FLOWGRAPH_COMBINED_SECRET = secret;
const threadId = "combined-progress-thread";
const allEvents = [];
let releaseHold;
let enteredHold;
let firstWait;
const holding = new Promise((resolve) => {
  releaseHold = resolve;
});
const entered = new Promise((resolve) => {
  enteredHold = resolve;
});
const waiting = new Promise((resolve) => {
  firstWait = resolve;
});
let effects = 0;
let pendingFirst;
async function deadline(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const gate = (id, output) => ({
  id,
  type: "wait",
  with: {
    webhook: { schema: { required: ["answer"], properties: { answer: { type: "string" } } } },
    output: { to: output },
  },
});
try {
  registerFunction("combined-hold", async () => {
    effects++;
    enteredHold();
    await holding;
    return {};
  });
  const compiled = await compileGraph(
    {
      apiVersion: "flowgraph/v1",
      kind: "Graph",
      metadata: { name: "combined-webhook-progress" },
      state: { channels: { first: { type: "object" }, second: { type: "object" } } },
      nodes: [
        gate("first-gate", "first"),
        { id: "hold", type: "function", with: { fn: "combined-hold", output: "none" } },
        gate("second-gate", "second"),
      ],
      edges: [
        { from: "START", to: "first-gate" },
        { from: "first-gate", to: "hold" },
        { from: "hold", to: "second-gate" },
        { from: "second-gate", to: "END" },
      ],
      runtime: {
        checkpoint: { enabled: true, backend: "memory" },
        webhookServer: {
          host: "127.0.0.1",
          port: 0,
          ingress: {
            id: "combined",
            signingSecretEnv: "FLOWGRAPH_COMBINED_SECRET",
            journalPath: path.join(temp, "receipts"),
          },
        },
      },
    },
    {
      sinks: [
        (event) => {
          allEvents.push(event);
          if (event.type === "interrupt.raised" && Array.isArray(event.data.interrupts))
            firstWait(event.data.interrupts[0]);
        },
      ],
    },
  );
  const streamEvents = [];
  let closed = false;
  const stream = (async () => {
    for await (const event of compiled.stream({
      threadId,
      correlation: { external: "combined-external" },
      onInterrupt: "webhook",
    }))
      streamEvents.push(event);
    closed = true;
  })();
  const interrupt = await deadline(waiting, "first wait");
  const endpoint = interrupt.payload.data.webhookUrl;
  async function signed(nodeId, deliveryId, answer) {
    const raw = JSON.stringify({
      correlation: { external: "combined-external" },
      nodeId,
      payload: { answer },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${deliveryId}.${new URL(endpoint).pathname}.`)
      .update(raw)
      .digest("hex");
    const response = await fetch(endpoint, {
      method: "POST",
      body: raw,
      headers: {
        "content-type": "application/json",
        "X-Flowgraph-Delivery-Id": deliveryId,
        "X-Flowgraph-Timestamp": timestamp,
        "X-Flowgraph-Signature": `sha256=${signature}`,
      },
      signal: AbortSignal.timeout(20_000),
    });
    return { http: response.status, body: await response.json() };
  }
  pendingFirst = signed("first-gate", "first-event", "first-answer");
  await deadline(entered, "held signed callback");
  const rejected = await compiled.resume({
    threadId,
    resume: { answer: "not-applied" },
    onInterrupt: "fail",
  });
  assert.equal(rejected.status, "error");
  assert.equal(rejected.error.code, "WEBHOOK_THREAD_BUSY");
  const rejectedStreamEvents = [];
  const rejectedStream = (async () => {
    for await (const event of compiled.stream({
      threadId,
      correlation: { external: "combined-external" },
      onInterrupt: "webhook",
    }))
      rejectedStreamEvents.push(event);
  })();
  await assert.rejects(
    deadline(rejectedStream, "rejected new stream"),
    (error) => error.code === "WEBHOOK_THREAD_BUSY",
  );
  assert.equal(rejectedStreamEvents.length, 0, "Rejected stream consumed owner events");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, "Busy admission terminated the owning stream");
  const warnings = allEvents.filter(
    (event) => event.type === "log" && event.data.code === "WEBHOOK_THREAD_BUSY",
  );
  assert(warnings.length >= 2);
  assert(warnings.every((event) => event.threadId === threadId));
  assert.equal(
    allEvents.some((event) => event.type === "run.error"),
    false,
  );

  releaseHold();
  assert.deepEqual(await pendingFirst, { http: 200, body: { status: "interrupted" } });
  assert.equal(effects, 1);
  const beforeDuplicate = allEvents.filter((event) => event.type === "state.update").length;
  const duplicate = await signed("first-gate", "first-event", "first-answer");
  assert.equal(duplicate.http, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(allEvents.filter((event) => event.type === "state.update").length, beforeDuplicate);
  assert.equal(closed, false);
  assert.deepEqual(await signed("second-gate", "second-event", "second-answer"), {
    http: 200,
    body: { status: "completed" },
  });
  await deadline(stream, "owning stream terminal");
  assert.equal(closed, true);
  assert.equal(streamEvents.at(-1).type, "run.end");
  assert(streamEvents.every((event) => event.threadId === threadId));
  const changes = streamEvents.filter((event) => event.type === "state.update");
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[0].data.update.first, { answer: "first-answer" });
  assert.deepEqual(changes[1].data.update.second, { answer: "second-answer" });
  assert(
    changes.every((event) => event.data.channels.every((channel) => !channel.startsWith("__"))),
  );
  const edges = streamEvents
    .filter((event) => event.type === "edge.taken")
    .map((event) => [event.data.from, event.data.to]);
  assert.deepEqual(edges, [
    ["START", "first-gate"],
    ["first-gate", "hold"],
    ["hold", "second-gate"],
    ["second-gate", "END"],
  ]);
  const final = await compiled.getState(threadId);
  assert.equal("__correlation" in final.values, false);
  assert.deepEqual(final.values.first, { answer: "first-answer" });
  assert.deepEqual(final.values.second, { answer: "second-answer" });
  console.log(
    JSON.stringify(
      {
        scenario: "Combined correlated callbacks and progress streams",
        heldCallbackEffects: effects,
        rejectedResume: rejected.error.code,
        rejectedStreamEvents: rejectedStreamEvents.length,
        warnings: warnings.length,
        ownerStayedOpenAcrossBusyAdmission: true,
        duplicateProducedNoProgress: true,
        stateUpdates: changes.map((event) => event.data),
        edges,
        privateCorrelationHidden: true,
        terminal: streamEvents.at(-1).type,
      },
      null,
      2,
    ),
  );
} finally {
  releaseHold();
  await pendingFirst?.catch(() => {});
  await closeWebhookServers();
  await fs.rm(temp, { recursive: true, force: true });
}
