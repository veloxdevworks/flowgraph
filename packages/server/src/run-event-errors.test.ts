import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readRunIssues, registerFunction } from "@flowgraph/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isSystemErrorText, maskIssuesIn, redactEventErrors, runErrorMessage } from "./event-errors.js";
import { loadEventJournal } from "./graph-source.js";
import { RunService } from "./run-service.js";
import type { ServerEvent } from "./types.js";

const SECRET = "/srv/flowgraph/private/creds.json";
const REFUSED = "connect ECONNREFUSED 10.0.3.4:5432";

/** The error `fs.open` throws for a file the server may not read. */
function eacces(): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, open '${SECRET}'`), { code: "EACCES", errno: -13, syscall: "open", path: SECRET });
}

const graph = (fn: string, extra = "") => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: event-errors }
state:
  channels:
    out: { type: object }
nodes:
  - { id: n, type: function, with: { fn: ${fn}, output: { to: out } }${extra} }
edges:
  - { from: START, to: n }
  - { from: n, to: END }
`;

beforeAll(() => {
  registerFunction("eventErrorsFsFail", async () => {
    throw eacces();
  });
  registerFunction("eventErrorsOwnFail", async () => {
    throw new Error("order 42 has no customer");
  });
  registerFunction("eventErrorsFailOnce", async (_input, ctx) => {
    if (ctx.attempt === 1) throw eacces();
    return { ok: true };
  });
  // What a failed memory recall leaves: an issue, and the block's error in memory.recall.
  registerFunction("eventErrorsRecallIssue", async (_input, ctx) => {
    ctx.issue({
      code: "MEMORY_RECALL_FAILED",
      severity: "warning",
      message: `memory recall block "notes" skipped: ${REFUSED}`,
      impact: "The agent ran without this recalled memory.",
      detail: { block: "notes", cause: REFUSED },
    });
    ctx.emit("memory.recall", { nodeId: ctx.nodeId, blocks: [{ id: "notes", candidates: 0, included: 0, error: REFUSED }] });
    return { ok: true };
  });
});

const dirs: string[] = [];
const services: RunService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of services.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

/** Capture error log lines, parsed. */
function captureErrorLog(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    try {
      lines.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      lines.push({ raw: String(line) });
    }
  });
  return lines;
}

async function newService(): Promise<{ service: RunService; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-event-errors-"));
  dirs.push(dir);
  const service = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 200 });
  services.push(service);
  await service.init();
  return { service, dir };
}

interface Seen {
  threadId: string;
  service: RunService;
  live: ServerEvent[];
  global: ServerEvent[];
  journal: ServerEvent[];
}

/**
 * Run `yaml` on a fresh server until the engine reports its end, and return
 * the thread's events as each client path sees them: the live session (SSE
 * and `/invocations` streams), the global feed (connect) and the journal.
 */
async function run(yaml: string): Promise<Seen> {
  const { service, dir } = await newService();
  const threadId = `t-${randomUUID()}`;
  const global: ServerEvent[] = [];
  const ended = new Promise<void>((resolve) => {
    service.registry.onGlobal((id, ev) => {
      if (id !== threadId) return;
      global.push(ev);
      if (ev.type === "run.end" || ev.type === "run.error") resolve();
    });
  });
  await service.startRun({ threadId, yaml, input: {} });
  await ended;
  return { threadId, service, live: service.registry.get(threadId)?.events ?? [], global, journal: loadEventJournal(dir, threadId) };
}

const dataOf = (ev: ServerEvent | undefined) => (ev?.data ?? {}) as Record<string, unknown>;
const MASKED = /^Internal server error \(error id (err_[0-9a-f]{12})\)$/;

describe("errors in run events", () => {
  it("a system error reaches no client path; each event has an error id matching a log line with the detail", async () => {
    const log = captureErrorLog();
    const { threadId, service, live, global } = await run(graph("eventErrorsFsFail"));
    await service.close();
    const journal = loadEventJournal(service.config.graphStoreDir, threadId);

    for (const events of [live, global, journal]) {
      expect(events.filter((e) => e.type === "node.error" || e.type === "run.error").map((e) => e.type)).toEqual(
        expect.arrayContaining(["node.error", "run.error"]),
      );
      const text = JSON.stringify(events);
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(/EACCES|permission denied/);
    }
    for (const ev of live.filter((e) => e.type === "node.error" || e.type === "run.error")) {
      const data = dataOf(ev);
      expect(data["errorId"]).toMatch(/^err_[0-9a-f]{12}$/);
      for (const f of ["message", "error"]) {
        if (f in data) expect(data[f]).toBe(`Internal server error (error id ${String(data["errorId"])})`);
      }
      const entry = log.find((l) => l["errorId"] === data["errorId"]);
      expect(entry).toMatchObject({ msg: expect.stringMatching(/^run\.(event\.)?error$/), threadId });
      expect(JSON.stringify(entry)).toContain(`EACCES: permission denied, open '${SECRET}'`);
    }
    expect(journal.filter((e) => e.type === "node.error").map((e) => dataOf(e)["errorId"])).toEqual(
      live.filter((e) => e.type === "node.error").map((e) => dataOf(e)["errorId"]),
    );
  });

  it("a retried node's failed attempt is masked in node.retry", async () => {
    const log = captureErrorLog();
    const { threadId, live, global } = await run(
      graph("eventErrorsFailOnce", ", retry: { maxAttempts: 2, backoff: fixed, baseMs: 1, jitter: false }"),
    );
    const retry = live.find((e) => e.type === "node.retry");
    expect(retry).toBeDefined();
    expect(dataOf(retry)).toMatchObject({ nodeId: "n", attempt: 1, error: expect.stringMatching(MASKED), errorId: expect.any(String) });
    for (const events of [live, global]) expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(log.find((l) => l["errorId"] === dataOf(retry)["errorId"])).toMatchObject({ msg: "run.event.error", threadId, source: "event node.retry" });
    expect(live.some((e) => e.type === "run.end")).toBe(true);
  });

  it("an issue holding system error text is masked in every event, the issues list, the run and the state", async () => {
    const log = captureErrorLog();
    const { threadId, service, live, global } = await run(graph("eventErrorsRecallIssue"));

    const issueEvent = live.find((e) => e.type === "run.issue");
    expect(dataOf(issueEvent)).toMatchObject({ code: "MEMORY_RECALL_FAILED", message: expect.stringMatching(MASKED), detail: { block: "notes", cause: expect.stringMatching(MASKED) } });
    const nodeEnd = live.find((e) => e.type === "node.end" && JSON.stringify(e.data).includes("__issues"));
    expect(nodeEnd).toBeDefined();
    const recall = live.find((e) => e.type === "memory.recall");
    expect(dataOf(recall)["blocks"]).toEqual([{ id: "notes", candidates: 0, included: 0, error: expect.stringMatching(MASKED) }]);

    const issues = await service.listIssues(threadId);
    expect(issues).toEqual([expect.objectContaining({ code: "MEMORY_RECALL_FAILED", message: expect.stringMatching(MASKED) })]);
    const runInfo = await service.getRun(threadId);
    const state = await service.getState(threadId);
    const history = await service.getHistory(threadId);

    for (const out of [live, global, issues, runInfo, state, history]) {
      expect(JSON.stringify(out)).not.toContain("10.0.3.4");
      expect(JSON.stringify(out)).not.toContain("ECONNREFUSED");
    }
    // One text, one id, wherever it shows up; logged once with the detail.
    const id = REFUSED_ID(threadId);
    for (const out of [issueEvent, nodeEnd, recall, issues, runInfo]) expect(JSON.stringify(out)).toContain(id);
    expect(log.filter((l) => l["msg"] === "run.event.error" && l["text"] === REFUSED)).toEqual([expect.objectContaining({ errorId: id, threadId })]);
    // The issues file on disk keeps the text as raised (server-side only).
    expect(JSON.stringify(readRunIssues(service.config.graphStoreDir, threadId))).toContain(REFUSED);
  });

  it("an error from the graph's own node keeps its message", async () => {
    captureErrorLog();
    const { live } = await run(graph("eventErrorsOwnFail"));
    const nodeError = live.find((e) => e.type === "node.error");
    expect(String(dataOf(nodeError)["error"])).toContain("order 42 has no customer");
    for (const ev of live) expect(ev.data).not.toHaveProperty("errorId");
  });
});

/** The id the masked ECONNREFUSED text gets in `threadId`. */
function REFUSED_ID(threadId: string): string {
  const out = redactEventErrors(threadId, event("hook.error", { error: REFUSED }));
  return String(dataOf(out)["errorId"]);
}

function event(type: string, data: Record<string, unknown>): ServerEvent {
  return { id: "e", type, ts: "", runId: "r", threadId: "x", graph: "g", scope: {}, seq: 1, data } as ServerEvent;
}

describe("masking", () => {
  it("recognises file-system and network error text, and nothing else", () => {
    expect(isSystemErrorText(`Error: EACCES: permission denied, open '${SECRET}'`)).toBe(true);
    expect(isSystemErrorText("wait timeout resume failed: ENOENT: no such file or directory, scandir '/var/x'")).toBe(true);
    expect(isSystemErrorText(REFUSED)).toBe(true);
    expect(isSystemErrorText("getaddrinfo ENOTFOUND db.internal")).toBe(true);
    expect(isSystemErrorText("order 42 has no customer")).toBe(false);
    expect(isSystemErrorText("ERROR: value too long, retry")).toBe(false);
    expect(isSystemErrorText("Node n failed: EXPECTED a number")).toBe(false);
  });

  it.each([
    ["run.error", { message: "TEXT", error: "TEXT", durationMs: 3 }],
    ["run.aborted", { message: "TEXT", error: "TEXT" }],
    ["run.issue", { code: "X", severity: "warning", message: "fine", detail: { cause: "TEXT" } }],
    ["node.error", { nodeId: "n", error: "TEXT" }],
    ["node.retry", { nodeId: "n", attempt: 1, error: "TEXT", delayMs: 1 }],
    ["hook.error", { phase: "run:before", hook: "h", error: "TEXT" }],
    ["skill.error", { skill: "s", reason: "TEXT" }],
  ])("masks %s wherever its data holds the text", (type, data) => {
    const log = captureErrorLog();
    const threadId = `u-${randomUUID()}`;
    const text = `ENOSPC: no space left on device, write '${SECRET}'`;
    const input = JSON.parse(JSON.stringify(data).replaceAll("TEXT", text)) as Record<string, unknown>;
    const out = redactEventErrors(threadId, event(type, input));
    const outData = dataOf(out);
    expect(JSON.stringify(outData)).not.toContain(SECRET);
    expect(outData["errorId"]).toMatch(/^err_[0-9a-f]{12}$/);
    expect(JSON.stringify(outData)).toBe(JSON.stringify({ ...JSON.parse(JSON.stringify(data).replaceAll("TEXT", `Internal server error (error id ${String(outData["errorId"])})`)), errorId: outData["errorId"] }));
    expect(log).toEqual([expect.objectContaining({ msg: "run.event.error", threadId, errorId: outData["errorId"], text, source: `event ${type}` })]);
  });

  it("masks a reason field on its own", () => {
    captureErrorLog();
    const out = redactEventErrors(`u-${randomUUID()}`, event("run.aborted", { reason: REFUSED }));
    expect(dataOf(out)["reason"]).toMatch(MASKED);
  });

  it("masks only the issues in a node update, and leaves other events alone", () => {
    captureErrorLog();
    const threadId = `u-${randomUUID()}`;
    const update = { out: { note: REFUSED }, __issues: [{ code: "X", message: REFUSED }] };
    const out = redactEventErrors(threadId, event("node.end", { nodeId: "n", update }));
    expect(dataOf(out)["update"]).toEqual({ out: { note: REFUSED }, __issues: [{ code: "X", message: expect.stringMatching(MASKED) }] });
    expect(maskIssuesIn(threadId, { values: update }, "state").value).toEqual({ values: { out: { note: REFUSED }, __issues: [{ code: "X", message: expect.stringMatching(MASKED) }] } });

    const output = event("node.output", { text: REFUSED });
    expect(redactEventErrors(threadId, output)).toBe(output);
    const plain = event("node.error", { nodeId: "n", error: "order 42 has no customer" });
    expect(redactEventErrors(threadId, plain)).toBe(plain);
  });

  it("a run failure the server catches itself is masked when it is a system error, whatever its message says", () => {
    expect(runErrorMessage(eacces(), "err_1")).toEqual({ message: "Internal server error (error id err_1)", redacted: true });
    // errno fields with a message that names no errno code
    const quiet = Object.assign(new Error(`cannot read ${SECRET}`), { code: "EACCES", errno: -13, syscall: "open", path: SECRET });
    expect(runErrorMessage(quiet, "err_2")).toEqual({ message: "Internal server error (error id err_2)", redacted: true });
    expect(runErrorMessage(new Error("order 42 has no customer"), "err_1")).toEqual({ message: "order 42 has no customer", redacted: false });
  });
});
