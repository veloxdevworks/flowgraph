/** PLAT-279: built engine, real signed HTTP, SQLite, process death, and CLI. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const secret = "local-e2e-signing-key-not-a-production-secret";
const secretEnv = "FLOWGRAPH_WEBHOOK_SECRET";
const STARTUP_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const endpointOf = (result) => result.interrupts?.[0]?.payload?.data?.webhookUrl;
const envelope = (
  nodeId = "first-gate",
  answer = "accepted",
  correlation = { external: "opaque-123" },
) => ({ correlation, nodeId, payload: { answer } });

if (process.argv[2] === "--worker") {
  const config = JSON.parse(process.argv[3]);
  const core = await import("../packages/core/dist/index.js");
  const { openSqliteBackend } = await import("../packages/checkpoint-sqlite/dist/index.js");
  const backend = await openSqliteBackend(config.db);
  core.registerFunction("record-delivery-effect", async ({ stage }) => {
    await fs.appendFile(config.effects, `${stage}\n`);
    if (config.holdStage === stage) {
      await fs.writeFile(config.entered, "entered");
      await new Promise(() => {});
    }
    return {};
  });
  const webhookServer = {
    host: "127.0.0.1",
    port: config.port ?? 0,
    ingress: {
      id: "verification",
      signingSecretEnv: secretEnv,
      journalPath: config.journal,
    },
  };
  const gate = (id, output) => ({
    id,
    type: "wait",
    with: {
      webhook: { schema: { required: ["answer"], properties: { answer: { type: "string" } } } },
      output: { to: output },
    },
  });
  const spec = {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "correlated-verification" },
    state: { channels: { first: { type: "object" }, second: { type: "object" } } },
    nodes: [
      gate("first-gate", "first"),
      {
        id: "first-effect",
        type: "function",
        with: { fn: "record-delivery-effect", input: { stage: "first" } },
      },
      gate("second-gate", "second"),
      {
        id: "second-effect",
        type: "function",
        with: { fn: "record-delivery-effect", input: { stage: "second" } },
      },
    ],
    edges: [
      { from: "START", to: "first-gate" },
      { from: "first-gate", to: "first-effect" },
      { from: "first-effect", to: "second-gate" },
      { from: "second-gate", to: "second-effect" },
      { from: "second-effect", to: "END" },
    ],
    runtime: { checkpoint: { enabled: true, backend: "sqlite" }, webhookServer },
  };
  const compiled = await core.compileGraph(spec, { checkpointer: backend.checkpointer });
  process.on("message", async (message) => {
    try {
      let result;
      if (message.command === "start")
        result = await compiled.run({
          threadId: message.threadId,
          correlation: message.correlation ?? { external: "opaque-123" },
          onInterrupt: "webhook",
        });
      else if (message.command === "state") result = await compiled.getState(message.threadId);
      else if (message.command === "listen") {
        const info = await core.ensureWebhookServer(webhookServer);
        result = { endpoint: `http://${info.host}:${info.port}/webhook-events/verification` };
      } else throw new Error(`Unknown command ${message.command}`);
      process.send({ id: message.id, result: JSON.parse(JSON.stringify(result)) });
    } catch (error) {
      process.send({ id: message.id, error: String(error) });
    }
  });
  process.send({ ready: true });
} else {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "fg-correlated-e2e-"));
  const children = new Set();
  const findings = [];
  let sequence = 0;
  const config = (name) => ({
    db: path.join(temp, `${name}.db`),
    journal: path.join(temp, `${name}-receipts`),
    effects: path.join(temp, `${name}-effects.txt`),
  });
  const effects = async (file) =>
    (await fs.readFile(file, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const record = (scenario, result) => {
    findings.push({ scenario, ...result });
    process.stderr.write(`Verified ${scenario}\n`);
  };
  async function stop(child) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGKILL");
      await ended;
    }
    children.delete(child);
  }
  async function worker(settings) {
    const child = fork(script, ["--worker", JSON.stringify(settings)], {
      silent: true,
      env: { ...process.env, [secretEnv]: secret, FLOWGRAPH_LOG_LEVEL: "silent" },
    });
    children.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    const pending = new Map();
    let ready;
    const started = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Worker startup timeout: ${stderr}`)),
        STARTUP_TIMEOUT_MS,
      );
      ready = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Worker exited ${code}/${signal}: ${stderr}`));
      });
    });
    child.on("message", (message) => {
      if (message.ready) return ready();
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    });
    child.on("exit", () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(`Worker exited: ${stderr}`));
      }
      pending.clear();
    });
    await started;
    return {
      child,
      stop: () => stop(child),
      rpc(command, threadId, correlation) {
        return new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Worker ${command} timeout: ${stderr}`));
          }, REQUEST_TIMEOUT_MS);
          pending.set(id, { resolve, reject, timer });
          child.send({ id, command, threadId, correlation });
        });
      },
    };
  }
  async function signed(url, body, eventId = "delivery-1", options = {}) {
    const raw = JSON.stringify(body);
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", options.secret ?? secret)
      .update(`${timestamp}.${eventId}.${new URL(url).pathname}.`)
      .update(raw)
      .digest("hex");
    const response = await fetch(url, {
      method: "POST",
      body: raw,
      headers: {
        "Content-Type": "application/json",
        "X-Flowgraph-Delivery-Id": eventId,
        "X-Flowgraph-Timestamp": timestamp,
        "X-Flowgraph-Signature": `sha256=${signature}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { http: response.status, body: await response.json() };
  }
  async function waitUntil(test, message, budget = REQUEST_TIMEOUT_MS) {
    const deadline = Date.now() + budget;
    while (!(await test())) {
      assert(Date.now() < deadline, message);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    const durable = config("durable");
    let instance = await worker(durable);
    const initial = await instance.rpc("start", "internal-thread");
    assert.equal(initial.status, "interrupted", JSON.stringify(initial));
    const endpoint = endpointOf(initial);
    assert(endpoint.endsWith("/webhook-events/verification"));
    const port = Number(new URL(endpoint).port);
    const unauthorized = await signed(endpoint, envelope(), "delivery-1", {
      secret: "wrong-local-signing-key",
    });
    const expired = await signed(endpoint, envelope(), "delivery-1", {
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });
    const invalid = await signed(endpoint, { ...envelope(), payload: { answer: 42 } });
    assert.equal(unauthorized.http, 401);
    assert.equal(expired.http, 401);
    assert.equal(invalid.http, 422);
    assert.equal((await instance.rpc("state", "internal-thread")).interrupts.length, 1);
    assert.deepEqual(await effects(durable.effects), []);
    record("authentication and validation rejection leave the original wait usable", {
      unauthorized: unauthorized.http,
      expired: expired.http,
      invalid: invalid.http,
      effects: 0,
    });

    await instance.stop();
    instance = await worker({ ...durable, port });
    const restored = await instance.rpc("state", "internal-thread");
    assert.equal(endpointOf(restored), endpoint);
    const first = await signed(endpoint, envelope());
    assert.deepEqual(first, { http: 200, body: { status: "interrupted" } });
    assert.deepEqual(await effects(durable.effects), ["first"]);
    await instance.stop();
    instance = await worker({ ...durable, port });
    const partial = await instance.rpc("state", "internal-thread");
    assert.equal(partial.interrupts.length, 1);
    assert.equal(partial.interrupts[0].payload.data.__nodeId, "second-gate");
    const duplicate = await signed(endpoint, envelope());
    assert.deepEqual(duplicate, { http: 200, body: { status: "interrupted", duplicate: true } });
    const conflict = await signed(endpoint, envelope("first-gate", "changed"));
    assert.equal(conflict.http, 409);
    assert.deepEqual(await effects(durable.effects), ["first"]);
    const second = await signed(endpoint, envelope("second-gate", "second-answer"), "delivery-2");
    assert.deepEqual(second, { http: 200, body: { status: "completed" } });
    assert.deepEqual(await effects(durable.effects), ["first", "second"]);
    const final = await instance.rpc("state", "internal-thread");
    assert.equal(final.interrupts.length, 0);
    assert(!("__correlation" in final.values));
    await instance.stop();
    instance = await worker({ ...durable, port });
    await instance.rpc("listen");
    assert.equal((await signed(endpoint, envelope())).body.duplicate, true);
    assert.equal(
      (await signed(endpoint, envelope("second-gate", "second-answer"), "delivery-2")).body
        .duplicate,
      true,
    );
    assert.deepEqual(await effects(durable.effects), ["first", "second"]);
    record(
      "SQLite and receipts survive SIGKILL before callback, after partial reply, and after completion",
      {
        first,
        duplicate,
        conflict: conflict.http,
        second,
        completedEffects: ["first", "second"],
        replayWithoutPendingRoutes: true,
      },
    );
    await instance.stop();

    const ambiguousConfig = config("ambiguous");
    const ambiguous = await worker(ambiguousConfig);
    const ambiguousUrl = endpointOf(
      await ambiguous.rpc("start", "run-a", { external: "shared", unique: "a" }),
    );
    await ambiguous.rpc("start", "run-b", { external: "shared", unique: "b" });
    const rejected = await signed(
      ambiguousUrl,
      envelope("first-gate", "accepted", { external: "shared" }),
    );
    assert.equal(rejected.http, 409);
    assert.equal(rejected.body.error, "ambiguous_correlation");
    const selected = await signed(
      ambiguousUrl,
      envelope("first-gate", "accepted", { external: "shared", unique: "b" }),
    );
    assert.equal(selected.http, 200);
    assert.equal(
      (await ambiguous.rpc("state", "run-a")).interrupts[0].payload.data.__nodeId,
      "first-gate",
    );
    assert.equal(
      (await ambiguous.rpc("state", "run-b")).interrupts[0].payload.data.__nodeId,
      "second-gate",
    );
    record("ambiguous external ids fail closed and a more precise callback selects one run", {
      ambiguous: rejected.http,
      selected: selected.body.status,
      untouchedRun: true,
    });
    await ambiguous.stop();

    const concurrentConfig = config("concurrent");
    const owner = await worker(concurrentConfig);
    const ownerUrl = endpointOf(await owner.rpc("start", "shared-thread"));
    const peer = await worker(concurrentConfig);
    const peerUrl = endpointOf(await peer.rpc("state", "shared-thread"));
    const concurrent = await Promise.all(
      Array.from({ length: 12 }, (_, index) => signed(index % 2 ? ownerUrl : peerUrl, envelope())),
    );
    assert(concurrent.some((r) => r.http === 200));
    assert(concurrent.every((r) => r.http === 200 || r.http === 409));
    assert.deepEqual(await effects(concurrentConfig.effects), ["first"]);
    assert.equal((await signed(peerUrl, envelope())).body.duplicate, true);
    // Peer may retain an old in-memory route: a new delivery cannot replay its old interrupt.
    const stale = await signed(peerUrl, envelope(), "new-id-old-gate");
    assert([404, 409].includes(stale.http), JSON.stringify(stale));
    await peer.rpc("state", "shared-thread");
    assert.equal(
      (await signed(peerUrl, envelope("second-gate", "final"), "delivery-2")).body.status,
      "completed",
    );
    assert.deepEqual(await effects(concurrentConfig.effects), ["first", "second"]);
    record("twelve overlapping deliveries across two Node processes apply one effect", {
      responses: concurrent.map((r) => r.http),
      firstEffects: 1,
      staleGate: stale.http,
      finalEffects: ["first", "second"],
    });
    await owner.stop();
    await peer.stop();

    const crashedConfig = {
      ...config("crash"),
      holdStage: "first",
      entered: path.join(temp, "entered"),
    };
    let crashing = await worker(crashedConfig);
    const crashUrl = endpointOf(await crashing.rpc("start", "crash-thread"));
    const crashPort = Number(new URL(crashUrl).port);
    const interruptedRequest = signed(crashUrl, envelope()).catch((error) => ({
      transportError: error.name,
    }));
    await waitUntil(
      () =>
        fs.access(crashedConfig.entered).then(
          () => true,
          () => false,
        ),
      "Effect did not start",
    );
    await crashing.stop();
    await interruptedRequest;
    crashing = await worker({ ...crashedConfig, holdStage: undefined, port: crashPort });
    const crashSnapshot = await crashing.rpc("state", "crash-thread");
    // The resume may have committed before the in-flight effect was killed, so
    // no webhook interrupt remains to rehydrate a listener. The host still
    // starts its configured ingress to answer durable receipt/in-doubt queries.
    await crashing.rpc("listen");
    const inDoubt = await signed(crashUrl, envelope());
    const locked = await signed(crashUrl, envelope(), "another-delivery");
    const gateStillWaiting = crashSnapshot.interrupts.some(
      (interrupt) => interrupt.payload.data.__nodeId === "first-gate",
    );
    assert.equal(inDoubt.http, 409);
    assert.equal(locked.http, gateStillWaiting ? 409 : 404);
    assert.equal(inDoubt.body.error, "delivery_in_doubt");
    assert.equal(locked.body.error, gateStillWaiting ? "thread_busy" : "not_waiting");
    assert.deepEqual(await effects(crashedConfig.effects), ["first"]);
    record("crash after a durable claim fails closed instead of invoking the effect again", {
      sameId: inDoubt.body.error,
      newId: locked.body.error,
      sameIdHttp: inDoubt.http,
      newIdHttp: locked.http,
      gateStillWaiting,
      effects: 1,
    });
    await crashing.stop();

    const core = await import("../packages/core/dist/index.js");
    const { spec, diagnostics } = await core.loadGraph(
      path.join(root, "examples/correlated-webhooks/correlated.graph.yaml"),
    );
    assert(spec, JSON.stringify(diagnostics));
    spec.runtime.webhookServer.port = 0;
    spec.runtime.webhookServer.ingress.journalPath = path.join(temp, "cli-receipts");
    spec.runtime.checkpoint.path = path.join(temp, "cli.db");
    const cliGraph = path.join(temp, "cli.graph.yaml");
    await fs.writeFile(cliGraph, JSON.stringify(spec));
    let cli = spawn(
      process.execPath,
      [
        path.join(root, "packages/cli/dist/bin.js"),
        "run",
        cliGraph,
        "--thread",
        "cli-thread",
        "--input",
        "externalId=cli-external",
        "--on-interrupt",
        "webhook",
        "--stream",
      ],
      {
        cwd: temp,
        env: { ...process.env, [secretEnv]: secret },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.add(cli);
    let output = "";
    cli.stdout.on("data", (chunk) => {
      output += chunk;
    });
    cli.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const cliEndpoint = () =>
      output.match(/http:\/\/127\.0\.0\.1:\d+\/webhook-events\/example/)?.[0];
    await waitUntil(
      () => cliEndpoint(),
      `CLI did not print endpoint: ${output}`,
      STARTUP_TIMEOUT_MS,
    );
    const cliFirst = await signed(
      cliEndpoint(),
      envelope("first-gate", "first", { external: "cli-external" }),
    );
    assert.equal(cliFirst.body.status, "interrupted");
    await waitUntil(
      () => (output.match(/Listening for webhook/g) ?? []).length >= 2,
      "CLI stopped waiting after its first gate",
    );
    await stop(cli);
    output = "";
    let jsonOutput = "";
    cli = spawn(
      process.execPath,
      [
        path.join(root, "packages/cli/dist/bin.js"),
        "resume",
        cliGraph,
        "--thread",
        "cli-thread",
        "--listen",
        "--on-interrupt",
        "webhook",
        "--json",
      ],
      {
        cwd: temp,
        env: { ...process.env, [secretEnv]: secret },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.add(cli);
    cli.stdout.on("data", (chunk) => {
      output += chunk;
      jsonOutput += chunk;
    });
    cli.stderr.on("data", (chunk) => {
      output += chunk;
    });
    await waitUntil(
      () => cliEndpoint(),
      `CLI did not restore endpoint: ${output}`,
      STARTUP_TIMEOUT_MS,
    );
    assert.equal(
      (await signed(cliEndpoint(), envelope("first-gate", "first", { external: "cli-external" })))
        .body.duplicate,
      true,
    );
    const cliSecond = await signed(
      cliEndpoint(),
      envelope("second-gate", "second", { external: "cli-external" }),
      "delivery-2",
    );
    assert.equal(cliSecond.body.status, "completed");
    await waitUntil(
      () => output.includes("Webhook received — run completed."),
      "CLI did not report completion",
    );
    const jsonEvents = jsonOutput
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert(jsonEvents.some((event) => event.type === "run.end"));
    assert(jsonEvents.every((event) => typeof event.type === "string"));
    record(
      "real CLI declares correlation from input and restores a signed wait using resume --listen",
      {
        firstStatus: cliFirst.body.status,
        finalStatus: cliSecond.body.status,
        completionPrinted: true,
        restoredWithoutSubmittingAnAnswer: true,
        oldDeliveryReplayedFromReceipt: true,
        jsonlStdoutContainsOnlyEvents: true,
        listenerRetainedAfterCompletion: cli.exitCode === null && cli.signalCode === null,
      },
    );
    await stop(cli);
    console.log(
      JSON.stringify(
        { node: process.version, platform: `${process.platform}/${process.arch}`, findings },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all([...children].map(stop));
    await fs.rm(temp, { recursive: true, force: true });
  }
}
