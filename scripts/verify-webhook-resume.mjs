/** PLAT-278: real HTTP + process-restart characterization. Run after pnpm build. */
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const graphPath = path.join(here, "../examples/webhook-resume/webhook-resume.graph.yaml");
const urlOf = (result) =>
  result.interrupts?.find((i) => i.payload?.data?.mode === "webhook")?.payload.data.webhookUrl;

if (process.argv[2] === "--worker") {
  const core = await import("../packages/core/dist/index.js");
  const { spec, diagnostics } = await core.loadGraph(graphPath);
  assert(spec, JSON.stringify(diagnostics));
  const config = JSON.parse(process.argv[3]);
  spec.runtime.webhookServer = {
    host: "127.0.0.1",
    port: config.port ?? 0,
    ...(config.token ? { token: config.token } : {}),
  };
  if (config.finishDelay) spec.nodes[1].with.duration = config.finishDelay;
  if (config.schema) spec.nodes[0].with.webhook = { schema: config.schema };
  if (config.sequential) {
    spec.nodes.splice(1, 0, { id: "await-second", type: "wait", with: { webhook: true } });
    spec.edges[1].to = "await-second";
    spec.edges.push({ from: "await-second", to: "finish" });
  }
  if (config.parallel) {
    spec.nodes = [
      spec.nodes[0],
      { id: "await-second", type: "wait", with: { webhook: true, output: { to: "second" } } },
    ];
    spec.state.channels.second = { type: "object" };
    spec.edges = [
      { from: "START", to: ["await-event", "await-second"] },
      { from: "await-event", to: "END" },
      { from: "await-second", to: "END" },
    ];
  }
  if (config.human)
    spec.nodes[0] = {
      id: "await-event",
      type: "hitl",
      with: { mode: "approve", message: "Continue?" },
    };
  const backend = config.db
    ? await (
        await import("../packages/checkpoint-sqlite/dist/index.js")
      ).openSqliteBackend(config.db)
    : null;
  const compiled = await core.compileGraph(spec, {
    checkpointer: backend?.checkpointer ?? "memory",
  });
  let finishes = 0;
  compiled.events.subscribe((event) => {
    if (event.type === "node.end" && event.scope.nodeId === "finish") finishes++;
  });
  process.on("message", async ({ id, command, threadId }) => {
    try {
      let result;
      if (command === "start") result = await compiled.run({ threadId, onInterrupt: "webhook" });
      else if (command === "state") result = await compiled.getState(threadId);
      else if (command === "inspect")
        result = { route: core.getWebhookRoute(threadId)?.url ?? null, finishes };
      else throw new Error(`Unknown command: ${command}`);
      process.send({ id, result: JSON.parse(JSON.stringify(result)) });
    } catch (error) {
      process.send({ id, error: String(error) });
    }
  });
  process.send({ ready: true });
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "flowgraph-webhook-spike-"));
  const children = new Set();
  const findings = [];
  let seq = 0;

  async function worker(config = {}) {
    const child = fork(fileURLToPath(import.meta.url), ["--worker", JSON.stringify(config)], {
      silent: true,
      env: { ...process.env, FLOWGRAPH_LOG_LEVEL: "silent" },
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
        () => reject(new Error(`Worker startup timed out: ${stderr}`)),
        15_000,
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
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error));
      else waiter.resolve(message.result);
    });
    child.on("exit", (code, signal) => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`Worker exited ${code}/${signal}: ${stderr}`));
      }
      pending.clear();
    });
    await started;
    return {
      child,
      stderr: () => stderr,
      rpc(command, threadId) {
        return new Promise((resolve, reject) => {
          const id = ++seq;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${command} timed out`));
          }, 15_000);
          pending.set(id, { resolve, reject, timer });
          child.send({ id, command, threadId });
        });
      },
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        children.delete(child);
      },
    };
  }

  async function request(url, body, headers = {}, method = "POST") {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(method === "POST" ? { body } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    return { http: response.status, body: await response.json() };
  }

  async function start(w, threadId) {
    const result = await w.rpc("start", threadId);
    assert.equal(result.status, "interrupted", JSON.stringify(result));
    assert(urlOf(result));
    return urlOf(result);
  }

  const record = (scenario, result) => {
    findings.push({ scenario, ...result });
    process.stderr.write(`Verified ${scenario}\n`);
  };

  try {
    const w = await worker({ token: "spike-local-token" });
    const auth = { Authorization: "Bearer spike-local-token" };
    const url = await start(w, "delayed");
    const before = await w.rpc("inspect", "delayed");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal((await w.rpc("inspect", "delayed")).finishes, before.finishes);
    assert.equal((await request(url, undefined, auth, "GET")).http, 200);
    for (const headers of [{}, { Authorization: "Bearer wrong" }])
      assert.equal((await request(url, "{}", headers)).http, 401);
    assert.equal((await request(url.replace("/await-event", "/unknown"), "{}", auth)).http, 404);
    assert.equal((await request(url, "{broken", auth)).http, 400);
    assert.equal((await request(url, undefined, auth, "GET")).body.waiting, true);
    const post = await request(url, '{"eventId":"event-1","value":42}', {
      "x-flowgraph-token": "spike-local-token",
    });
    assert.deepEqual(post, { http: 200, body: { status: "completed" } });
    assert.equal((await w.rpc("state", "delayed")).values.received.value, 42);
    assert.equal((await w.rpc("inspect", "delayed")).finishes, 1);
    const duplicate = await request(url, '{"eventId":"event-1"}', auth);
    assert.equal(duplicate.http, 404);
    record("delayed POST, auth, wrong route, invalid JSON, sequential duplicate", {
      post,
      duplicate,
      finishes: 1,
      dwellMs: 1000,
    });

    const urls = await Promise.all(
      Array.from({ length: 8 }, (_, i) => start(w, `concurrent-${i}`)),
    );
    const posts = await Promise.all(
      urls.map((u, i) => request(u, JSON.stringify({ value: i }), auth)),
    );
    assert(posts.every((p) => p.http === 200 && p.body.status === "completed"));
    for (let i = 0; i < urls.length; i++)
      assert.equal((await w.rpc("state", `concurrent-${i}`)).values.received.value, i);
    record("eight concurrent waiting threads", {
      http: posts.map((p) => p.http),
      finishes: (await w.rpc("inspect", "delayed")).finishes,
    });
    await w.stop();

    const strict = await worker({
      schema: { type: "object", required: ["value"], properties: { value: { type: "number" } } },
    });
    const missingUrl = await start(strict, "missing-field");
    const beforeRejection = await strict.rpc("state", "missing-field");
    const missing = await request(missingUrl, "{}");
    assert.equal(missing.http, 422);
    assert.equal(missing.body.status, "interrupted");
    assert.equal((await request(missingUrl, undefined, {}, "GET")).body.waiting, true);
    assert.deepEqual(await strict.rpc("state", "missing-field"), beforeRejection);
    const wrongType = await request(missingUrl, '{"value":"not-a-number"}');
    assert.equal(wrongType.http, 422);
    assert.equal((await strict.rpc("inspect", "missing-field")).finishes, 0);
    const afterLoad = await strict.rpc("state", "missing-field");
    assert.deepEqual(afterLoad, beforeRejection);
    const retry = await request(missingUrl, '{"value":42}');
    assert.deepEqual(retry, { http: 200, body: { status: "completed" } });
    assert.equal((await strict.rpc("state", "missing-field")).values.received.value, 42);
    assert.equal((await strict.rpc("inspect", "missing-field")).finishes, 1);
    record("missing required field and retry", {
      missing,
      wrongType,
      checkpointUnchangedAfterRejection: true,
      retry,
      nextAfterLoad: afterLoad.next,
    });
    await strict.stop();

    const retryConfig = {
      db: path.join(temp, "retry-validation.db"),
      token: "retry-local-token",
      schema: { required: ["value"], properties: { value: { type: "number" } } },
    };
    const retryAuth = { Authorization: "Bearer retry-local-token" };
    const rejected = await worker(retryConfig);
    const retryUrl = await start(rejected, "retry-restart");
    const beforeRestartRejection = await rejected.rpc("state", "retry-restart");
    assert.equal((await request(retryUrl, "{}", retryAuth)).http, 422);
    assert.deepEqual(await rejected.rpc("state", "retry-restart"), beforeRestartRejection);
    await rejected.stop();
    const restoredRetry = await worker({ ...retryConfig, port: Number(new URL(retryUrl).port) });
    assert.equal((await restoredRetry.rpc("inspect", "retry-restart")).route, null);
    const restoredWait = await restoredRetry.rpc("state", "retry-restart");
    assert.equal(restoredWait.checkpointId, beforeRestartRejection.checkpointId);
    assert.equal(urlOf(restoredWait), retryUrl);
    assert.equal((await request(retryUrl, '{"value":"wrong"}', retryAuth)).http, 422);
    assert.deepEqual(await restoredRetry.rpc("state", "retry-restart"), restoredWait);
    const correctedAfterRestart = await request(retryUrl, '{"value":7}', retryAuth);
    assert.deepEqual(correctedAfterRestart, { http: 200, body: { status: "completed" } });
    assert.equal((await restoredRetry.rpc("inspect", "retry-restart")).finishes, 1);
    assert.equal((await restoredRetry.rpc("state", "retry-restart")).values.received.value, 7);
    record("rejected callbacks preserve the wait across SIGKILL and SQLite reload", {
      checkpointUnchangedAfterRejection: true,
      sameUrl: true,
      correctedAfterRestart,
      finishes: 1,
    });
    await restoredRetry.stop();

    for (const value of [false, 0, "", null]) {
      const scalar = await worker();
      const result = await request(await start(scalar, "scalar"), JSON.stringify(value));
      assert.deepEqual(result, { http: 200, body: { status: "completed" } });
      const snapshot = await scalar.rpc("state", "scalar");
      assert.deepEqual(snapshot.values.received, { value });
      record(`JSON scalar ${JSON.stringify(value)}`, {
        result,
        snapshot,
      });
      await scalar.stop();
    }

    const overlap = await worker({ finishDelay: "250ms" });
    const overlapUrl = await start(overlap, "overlap");
    // Both handlers select the route before either request body finishes.
    const slowPost = () => {
      let resolveHeaders;
      const headersSent = new Promise((resolve) => {
        resolveHeaders = resolve;
      });
      let req;
      const response = new Promise((resolve, reject) => {
        req = http.request(
          overlapUrl,
          {
            method: "POST",
            headers: {
              Expect: "100-continue",
              "Content-Type": "application/json",
              "Content-Length": 14,
            },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () => resolve({ http: res.statusCode, body: JSON.parse(body) }));
          },
        );
        req.on("error", reject);
        req.setTimeout(10_000, () => req.destroy(new Error("Slow POST timed out")));
        req.once("continue", resolveHeaders);
        req.flushHeaders();
      });
      return { response, headersSent, finish: () => req.end('{"value":true}') };
    };
    const a = slowPost();
    const b = slowPost();
    await Promise.all([a.headersSent, b.headersSent]);
    a.finish();
    b.finish();
    const [first, second] = await Promise.all([a.response, b.response]);
    assert.deepEqual([first.http, second.http].sort(), [200, 404]);
    const finishes = (await overlap.rpc("inspect", "overlap")).finishes;
    assert.equal(finishes, 1);
    record("overlapping duplicate POSTs", {
      first,
      second,
      finishes,
    });
    await overlap.stop();

    const db = path.join(temp, "checkpoints.db");
    const original = await worker({ db });
    const originalUrl = await start(original, "restart");
    const port = Number(new URL(originalUrl).port);
    await original.stop();
    const restarted = await worker({ db, port });
    assert.equal((await restarted.rpc("inspect", "restart")).route, null);
    const restored = await restarted.rpc("state", "restart");
    assert.equal(urlOf(restored), originalUrl);
    const recovered = await request(originalUrl, '{"value":"survived-restart"}');
    assert.deepEqual(recovered, { http: 200, body: { status: "completed" } });
    assert.equal(
      (await restarted.rpc("state", "restart")).values.received.value,
      "survived-restart",
    );
    record("SIGKILL + SQLite + new process + getState", {
      routeBeforeLoad: null,
      sameUrl: true,
      recovered,
      finishes: (await restarted.rpc("inspect", "restart")).finishes,
    });
    await restarted.stop();
    const reopened = await worker({ db });
    const completed = await reopened.rpc("state", "restart");
    assert.deepEqual(completed.next, []);
    assert.equal(completed.values.received.value, "survived-restart");
    assert.equal((await reopened.rpc("inspect", "restart")).route, null);
    record("completed checkpoint reopened in third process", {
      next: completed.next,
      received: completed.values.received,
      route: null,
    });
    await reopened.stop();

    const sequential = await worker({ sequential: true });
    const nextWait = await request(await start(sequential, "two-waits"), "{}");
    assert.equal(nextWait.body.status, "interrupted");
    const nextUrl = urlOf(await sequential.rpc("state", "two-waits"));
    assert(nextUrl.endsWith("/await-second"));
    assert.equal((await request(nextUrl, "{}")).body.status, "completed");
    record("two sequential webhook waits", {
      firstStatus: "interrupted",
      secondStatus: "completed",
    });
    await sequential.stop();

    const parallel = await worker({ parallel: true });
    const parallelResult = await parallel.rpc("start", "two-gates");
    const registered = await parallel.rpc("inspect", "two-gates");
    const gatePosts = [];
    for (const interrupt of parallelResult.interrupts)
      gatePosts.push(await request(interrupt.payload.data.webhookUrl, '{"value":1}'));
    record("two parallel webhook waits in one thread", {
      interrupts: parallelResult.interrupts.length,
      registered: registered.route,
      gatePosts,
      state: await parallel.rpc("state", "two-gates"),
    });
    await parallel.stop();

    const human = await worker({ human: true });
    const humanResult = await human.rpc("start", "human-policy");
    record("HITL with onInterrupt webhook", {
      status: humanResult.status,
      kind: humanResult.interrupts[0].kind,
      hasWebhookUrl: Boolean(urlOf(humanResult)),
      route: (await human.rpc("inspect", "human-policy")).route,
    });
    await human.stop();

    const cli = spawn(
      process.execPath,
      [
        path.join(here, "../packages/cli/dist/bin.js"),
        "run",
        graphPath,
        "--thread",
        "cli-spike",
        "--on-interrupt",
        "webhook",
        "--stream",
      ],
      {
        cwd: temp,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FLOWGRAPH_LOG_LEVEL: "silent" },
      },
    );
    children.add(cli);
    let cliOutput = "";
    cli.stdout.on("data", (chunk) => {
      cliOutput += chunk;
    });
    cli.stderr.on("data", (chunk) => {
      cliOutput += chunk;
    });
    async function waitForCli(predicate) {
      const deadline = Date.now() + 10_000;
      while (!predicate(cliOutput)) {
        assert.equal(cli.exitCode, null, cliOutput);
        assert(Date.now() < deadline, `CLI timed out: ${cliOutput}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await waitForCli((output) =>
      /http:\/\/127\.0\.0\.1:\d+\/webhooks\/cli-spike\/await-event/.test(output),
    );
    const cliUrl = cliOutput.match(
      /http:\/\/127\.0\.0\.1:\d+\/webhooks\/cli-spike\/await-event/,
    )[0];
    const cliPost = await request(cliUrl, '{"value":"from-cli"}');
    assert.equal(cliPost.body.status, "completed");
    await waitForCli((output) => output.includes("Completed after webhook resume."));
    await new Promise((resolve) => setTimeout(resolve, 500));
    record("CLI YAML run and real POST", {
      cliPost,
      completionPrinted: true,
      aliveAfterCompletion: cli.exitCode === null && cli.signalCode === null,
    });
    if (cli.exitCode === null && cli.signalCode === null) {
      const exited = once(cli, "exit");
      cli.kill("SIGKILL");
      await exited;
    }
    children.delete(cli);

    const malformedPath = await worker();
    const pathUrl = await start(malformedPath, "path");
    const badPath = pathUrl.replace("/path/", "/%ZZ/");
    const pathResponse = await request(badPath, "{}");
    assert.equal(pathResponse.http, 400);
    assert.equal(pathResponse.body.error, "invalid_path");
    const afterInvalidPath = await request(pathUrl, '{"value":"still-alive"}');
    assert.deepEqual(afterInvalidPath, { http: 200, body: { status: "completed" } });
    record("malformed percent-encoded route", {
      pathResponse,
      afterInvalidPath,
      alive: malformedPath.child.exitCode === null && malformedPath.child.signalCode === null,
    });
    await malformedPath.stop();

    console.log(
      JSON.stringify(
        { node: process.version, platform: `${process.platform}/${process.arch}`, findings },
        null,
        2,
      ),
    );
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
