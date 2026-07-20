#!/usr/bin/env node
/**
 * End-to-end smoke for flowgraph-server (REST + SSE + AgentCore).
 * Usage: node packages/server/scripts/smoke-e2e.mjs [baseUrl]
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const bin = path.join(root, "packages/server/dist/bin.js");

const PORT = Number(process.env.SMOKE_PORT ?? 18081);
const BASE = process.env.SMOKE_BASE ?? `http://127.0.0.1:${PORT}`;
const TOKEN = "dev-smoke";
const EXTERNAL = Boolean(process.env.SMOKE_BASE);

const HTTP_GRAPH = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: smoke-http
state:
  channels:
    resp: { type: object }
nodes:
  - id: fetch
    type: http
    with:
      method: GET
      url: https://example.com
      expect:
        status: [200]
      output: { to: resp }
edges:
  - { from: START, to: fetch }
  - { from: fetch, to: END }
runtime:
  checkpoint: { enabled: true, backend: memory }
`;

const HITL_GRAPH = `
apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: smoke-hitl
state:
  channels:
    approval: { type: object }
nodes:
  - id: gate
    type: hitl
    with:
      mode: approve
      message: "Smoke approve?"
      output: { to: approval }
edges:
  - { from: START, to: gate }
  - { from: gate, to: END }
runtime:
  checkpoint: { enabled: true, backend: memory }
  hitl:
    onInterrupt: fail
`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitHealthy(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${url}/ping`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`Server not healthy at ${url}`);
}

async function json(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} → ${res.status}: ${text}`);
  }
  return data;
}

async function collectSse(threadId, { untilTypes, timeoutMs = 20_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(`${BASE}/runs/${encodeURIComponent(threadId)}/events`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "text/event-stream",
      },
      signal: controller.signal,
    });
    assert(res.ok, `SSE status ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const dataLine = part
          .split("\n")
          .find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const ev = JSON.parse(dataLine.slice(5).trim());
        events.push(ev);
        if (untilTypes.has(String(ev.type))) {
          controller.abort();
          return events;
        }
      }
    }
  } catch (err) {
    if (err?.name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

async function main() {
  let child;
  let tmp;
  if (!EXTERNAL) {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fg-smoke-"));
    child = spawn(process.execPath, [bin], {
      cwd: root,
      env: {
        ...process.env,
        FLOWGRAPH_HOST: "127.0.0.1",
        FLOWGRAPH_PORT: String(PORT),
        FLOWGRAPH_AUTH_TOKEN: TOKEN,
        FLOWGRAPH_GRAPH_STORE: tmp,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
    child.stderr.on("data", (d) => process.stderr.write(`[server.err] ${d}`));
    await waitHealthy(BASE);
  } else {
    await waitHealthy(BASE);
  }

  const results = [];

  // 1) AgentCore ping
  {
    const res = await fetch(`${BASE}/ping`);
    const body = await res.json();
    assert(res.ok, "ping failed");
    assert(body.status === "Healthy" || body.status === "HealthyBusy", `bad ping ${body.status}`);
    results.push(`PASS ping → ${body.status}`);
  }

  // 2) Auth rejection
  {
    const res = await fetch(`${BASE}/healthz`);
    assert(res.status === 401, `expected 401 without token, got ${res.status}`);
    results.push("PASS auth rejects unauthenticated /healthz");
  }

  // 3) healthz with token
  {
    const health = await json("GET", "/healthz");
    assert(health.ok === true, "healthz not ok");
    results.push(`PASS healthz (database=${health.database})`);
  }

  // 4) Client secrets rejected
  {
    let rejected = false;
    try {
      await json("POST", "/runs", {
        threadId: "reject-secrets",
        yaml: HTTP_GRAPH,
        env: { OPENAI_API_KEY: "sk-test" },
      });
    } catch (err) {
      rejected = String(err.message).includes("400") || String(err.message).includes("reject");
    }
    assert(rejected, "expected client secrets rejection");
    results.push("PASS reject client secrets");
  }

  // 5) HTTP graph via REST + SSE
  {
    const threadId = `http-${Date.now()}`;
    const sseP = collectSse(threadId, {
      untilTypes: new Set(["run.end", "run.error"]),
      timeoutMs: 30_000,
    });
    await sleep(150);
    const start = await json("POST", "/runs", {
      threadId,
      yaml: HTTP_GRAPH,
      input: {},
    });
    assert(start.status === "started", `start status ${start.status}`);
    const events = await sseP;
    const types = events.map((e) => e.type);
    assert(types.includes("run.start") || types.includes("node.start"), `no start events: ${types}`);
    assert(types.includes("run.end") || types.includes("run.error"), `no terminal: ${types}`);
    const failed = events.find((e) => e.type === "run.error");
    assert(!failed, `run.error: ${JSON.stringify(failed?.data)}`);
    const state = await json("GET", `/runs/${threadId}/state`);
    assert(state.state, "missing state after run");
    results.push(`PASS REST+SSE http graph (${events.length} events)`);
  }

  // 6) HITL interrupt + resume
  {
    const threadId = `hitl-${Date.now()}`;
    const sseP = collectSse(threadId, {
      untilTypes: new Set(["interrupt.raised", "run.error"]),
      timeoutMs: 15_000,
    });
    await sleep(150);
    await json("POST", "/runs", { threadId, yaml: HITL_GRAPH, input: {} });
    const interrupted = await sseP;
    assert(
      interrupted.some((e) => e.type === "interrupt.raised"),
      `expected interrupt.raised, got ${interrupted.map((e) => e.type)}`,
    );

    const resumeSse = collectSse(threadId, {
      untilTypes: new Set(["run.end", "run.error", "interrupt.raised"]),
      timeoutMs: 15_000,
    });
    await sleep(100);
    const resumed = await json("POST", `/runs/${threadId}/resume`, {
      resume: { approved: true },
    });
    // Fire-and-forget: RPC returns immediately; outcome arrives over SSE.
    assert(resumed.status === "started", `resume status ${resumed.status}`);
    const after = await resumeSse;
    assert(
      after.some((e) => e.type === "run.end"),
      `expected run.end after resume, got ${after.map((e) => e.type)}`,
    );
    results.push("PASS HITL interrupt + resume → completed");
  }

  // 7) AgentCore /invocations start (stream until terminal)
  {
    const threadId = `ac-${Date.now()}`;
    const res = await fetch(`${BASE}/invocations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        action: "start",
        threadId,
        yaml: HTTP_GRAPH,
        stream: true,
      }),
    });
    assert(res.ok, `invocations ${res.status}`);
    const text = await res.text();
    assert(text.includes("run.start") || text.includes("node.start"), "invocations stream missing start");
    assert(text.includes("run.end") || text.includes("run.error"), "invocations stream missing terminal");
    assert(!text.includes('"type":"run.error"'), `invocations run.error in stream`);
    results.push("PASS AgentCore /invocations start+stream");
  }

  // 8) Busy ping while? (optional — after runs should be Healthy)
  {
    const body = await (await fetch(`${BASE}/ping`)).json();
    results.push(`PASS final ping → ${body.status}`);
  }

  console.log("\n=== smoke results ===");
  for (const line of results) console.log(line);
  console.log("ALL PASSED");

  if (child) {
    child.kill("SIGTERM");
    await sleep(200);
    child.kill("SIGKILL");
  }
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
}

main().catch((err) => {
  console.error("\nSMOKE FAILED:", err);
  process.exit(1);
});
