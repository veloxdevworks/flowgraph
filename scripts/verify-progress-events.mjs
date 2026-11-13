#!/usr/bin/env node
// Run after pnpm build. Uses built packages, fresh CLI processes, real HTTP/SSE,
// and a temporary SQLite checkpoint file; no network service or model key needed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { compileGraph, registerFunction } from "../packages/core/dist/index.js";
import {
  RunService,
  createHttpServer,
  defaultServerConfig,
} from "../packages/server/dist/index.js";

process.env.FLOWGRAPH_LOG_LEVEL = "error";
const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "flowgraph-progress-"));
const findings = [];
const progress = (events) =>
  events.filter((event) => ["state.update", "edge.taken"].includes(event.type));
const stateChanges = (events) => events.filter((event) => event.type === "state.update");
const edges = (events) =>
  events.filter((event) => event.type === "edge.taken").map((event) => event.data);
const parseJsonl = (text) =>
  text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
let server;
let service;
const sseReaders = [];

async function cli(args, expectedExit = 0) {
  let result;
  try {
    result = {
      ...(await execFileAsync(
        process.execPath,
        [path.join(root, "packages/cli/dist/bin.js"), ...args],
        {
          cwd: temp,
          timeout: 20_000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, FLOWGRAPH_LOG_LEVEL: "silent" },
        },
      )),
      code: 0,
    };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    result = error;
  }
  assert.equal(result.code, expectedExit, result.stderr);
  return parseJsonl(result.stdout);
}

const gateSpec = {
  apiVersion: "flowgraph/v1",
  kind: "Graph",
  metadata: { name: "progress-gate" },
  state: { channels: { stage: { type: "string" }, answer: { type: "object" } } },
  nodes: [
    {
      id: "route",
      type: "router",
      with: { routes: { waiting: { default: true, to: "gate" } }, output: { to: "stage" } },
    },
    { id: "gate", type: "wait", with: { signal: "approval", output: { to: "answer" } } },
  ],
  edges: [
    { from: "START", to: "route" },
    { from: "route", to: "gate" },
    { from: "gate", to: "END" },
  ],
  runtime: { checkpoint: { enabled: true, backend: "memory" } },
};

try {
  registerFunction("verify-progress-left", () => ["left"]);
  registerFunction("verify-progress-right", () => ["right"]);
  const parallel = {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "progress-parallel" },
    state: { channels: { items: { type: "array", reducer: "append", default: ["seed"] } } },
    nodes: ["left", "right"].map((id) => ({
      id,
      type: "function",
      with: { fn: `verify-progress-${id}`, output: { to: "items" } },
    })),
    edges: [
      { from: "START", to: ["left", "right"] },
      { from: "left", to: "END" },
      { from: "right", to: "END" },
    ],
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  };
  const compiled = await compileGraph(parallel);
  const streamed = [];
  for await (const event of compiled.stream({ threadId: "programmatic-progress" }))
    streamed.push(event);
  assert.equal(streamed.at(-1).type, "run.end");
  assert.equal(stateChanges(streamed).length, 1);
  assert.deepEqual(stateChanges(streamed)[0].data.update.items, ["seed", "left", "right"]);
  assert.equal(edges(streamed).length, 4);
  assert(streamed.every((event) => event.threadId === "programmatic-progress"));
  findings.push({
    scenario: "built API stream, parallel reducers and terminal delivery",
    progress: progress(streamed),
    terminal: streamed.at(-1).type,
  });

  const cliEvents = await cli([
    "run",
    path.join(root, "examples/quickstart/quickstart.graph.yaml"),
    "--input",
    "text=Hello Flowgraph",
    "--thread",
    "quickstart-progress",
    "--json",
  ]);
  assert.deepEqual(
    edges(cliEvents).map(({ from, to }) => [from, to]),
    [
      ["START", "make-slug"],
      ["make-slug", "count"],
      ["count", "END"],
    ],
  );
  assert.equal(stateChanges(cliEvents).length, 2);
  assert.equal(stateChanges(cliEvents)[0].data.update.slug, "hello-flowgraph");
  assert.equal(stateChanges(cliEvents)[1].data.update.words, 2);
  assert(stateChanges(cliEvents).every((event) => !event.data.channels.includes("text")));
  assert.equal(cliEvents.at(-1).type, "run.end");
  assert(cliEvents.every((event) => event.threadId === "quickstart-progress"));
  findings.push({
    scenario: "real CLI JSONL quickstart and natural exit 0",
    progress: progress(cliEvents),
    terminal: cliEvents.at(-1).type,
  });

  const sqliteGraph = path.join(temp, "gate.graph.yaml");
  await fs.writeFile(
    sqliteGraph,
    JSON.stringify({
      ...gateSpec,
      runtime: {
        checkpoint: { enabled: true, backend: "sqlite", path: path.join(temp, "checkpoints.db") },
      },
    }),
  );
  const before = await cli(
    ["run", sqliteGraph, "--thread", "sqlite-progress", "--json", "--on-interrupt", "fail"],
    3,
  );
  assert.equal(stateChanges(before).length, 1);
  assert.equal(stateChanges(before)[0].data.update.stage, "waiting");
  assert(!edges(before).some((event) => event.from === "gate"));
  const after = await cli([
    "resume",
    sqliteGraph,
    "--thread",
    "sqlite-progress",
    "--resume",
    '{"approved":true}',
    "--json",
    "--on-interrupt",
    "fail",
  ]);
  assert.equal(stateChanges(after).length, 1);
  assert.deepEqual(stateChanges(after)[0].data.update.answer, { approved: true });
  assert(!stateChanges(after)[0].data.channels.includes("stage"));
  assert.deepEqual(edges(after), [{ from: "gate", to: "END", kind: "static" }]);
  assert.equal(after.at(-1).type, "run.end");
  findings.push({
    scenario: "SQLite interrupt and resume in separate CLI processes",
    before: progress(before),
    after: progress(after),
    terminal: after.at(-1).type,
    baselineNotReemitted: true,
  });

  const config = defaultServerConfig({
    FLOWGRAPH_GRAPH_STORE: path.join(temp, "graphs"),
    FLOWGRAPH_AUTH_TOKEN: "progress-verification-token",
    FLOWGRAPH_AUTH_MODE: "token",
  });
  service = new RunService(config);
  await service.init();
  server = createHttpServer(service, config);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    authorization: "Bearer progress-verification-token",
    "content-type": "application/json",
  };
  async function request(url, method = "GET", body) {
    const response = await fetch(base + url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json();
    assert(response.ok, JSON.stringify(data));
    return data;
  }
  async function openEvents(afterSeq = -1) {
    const abort = new AbortController();
    const response = await fetch(`${base}/runs/http-progress/events`, {
      headers: {
        ...headers,
        ...(afterSeq === undefined ? {} : { "last-event-id": String(afterSeq) }),
      },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader();
    sseReaders.push({ reader, abort });
    let pending = "";
    const events = [];
    const decoder = new TextDecoder();
    return {
      events,
      async until(predicate) {
        while (!events.some(predicate)) {
          const next = await reader.read();
          assert(!next.done, "SSE closed before expected event");
          pending += decoder.decode(next.value, { stream: true });
          let separator;
          while ((separator = pending.indexOf("\n\n")) !== -1) {
            const frame = pending.slice(0, separator);
            pending = pending.slice(separator + 2);
            const data = frame.split("\n").find((line) => line.startsWith("data: "));
            if (data) events.push(JSON.parse(data.slice(6)));
          }
        }
      },
    };
  }
  await request("/runs", "POST", { threadId: "http-progress", yaml: JSON.stringify(gateSpec) });
  const live = await openEvents();
  await live.until(
    (event) => event.type === "interrupt.raised" && Array.isArray(event.data.interrupts),
  );
  assert.equal(stateChanges(live.events).length, 1);
  assert.equal(stateChanges(live.events)[0].data.update.stage, "waiting");
  assert(!edges(live.events).some((event) => event.from === "gate"));
  const initialProgressSeq = stateChanges(live.events)[0].seq;
  await request("/runs/http-progress/resume", "POST", { resume: { approved: true } });
  await live.until((event) => event.type === "run.end");
  assert.equal(stateChanges(live.events).length, 2);
  assert.deepEqual(stateChanges(live.events)[1].data.update.answer, { approved: true });
  assert.deepEqual(edges(live.events), [
    { from: "START", to: "route", kind: "static" },
    { from: "route", to: "gate", kind: "command" },
    { from: "gate", to: "END", kind: "static" },
  ]);
  assert(live.events.every((event) => event.threadId === "http-progress"));
  const journal = await request("/runs/http-progress/journal");
  assert.deepEqual(progress(journal.events), progress(live.events));
  const replay = await openEvents(initialProgressSeq);
  await replay.until((event) => event.type === "run.end");
  assert.deepEqual(
    replay.events,
    journal.events.filter((event) => event.seq > initialProgressSeq),
  );
  const state = await request("/runs/http-progress/state");
  findings.push({
    scenario: "real authenticated REST, live SSE across resume, Last-Event-ID replay and journal",
    progress: progress(live.events),
    replayedEvents: replay.events.length,
    journalMatchesSse: true,
    state,
  });

  console.log(
    JSON.stringify(
      {
        ticket: "PLAT-281",
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        findings,
      },
      null,
      2,
    ),
  );
} finally {
  for (const { reader, abort } of sseReaders) {
    abort.abort();
    await reader.cancel().catch(() => {});
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await service?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
