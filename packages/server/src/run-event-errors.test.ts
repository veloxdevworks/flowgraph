import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerFunction } from "@flowgraph/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isSystemErrorText, redactEventErrors, runErrorMessage } from "./event-errors.js";
import { loadEventJournal } from "./graph-source.js";
import { RunService } from "./run-service.js";
import type { ServerEvent } from "./types.js";

const SECRET = "/srv/flowgraph/private/creds.json";

/** The error `fs.open` throws for a file the server may not read. */
function eacces(): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, open '${SECRET}'`), { code: "EACCES", errno: -13, syscall: "open", path: SECRET });
}

const graph = (fn: string) => `
apiVersion: flowgraph/v1
kind: Graph
metadata: { name: event-errors }
state:
  channels:
    out: { type: object }
nodes:
  - { id: n, type: function, with: { fn: ${fn}, output: { to: out } } }
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
});

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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

/**
 * Run `fn` to its end on a fresh server and return the thread's events as
 * each client path sees them: the live session (SSE and `/invocations`
 * streams), the global feed (connect) and the on-disk journal.
 */
async function runToEnd(fn: string): Promise<{ live: ServerEvent[]; global: ServerEvent[]; journal: ServerEvent[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-event-errors-"));
  dirs.push(dir);
  const service = new RunService({ host: "127.0.0.1", port: 0, graphStoreDir: dir, eventBufferSize: 100 });
  await service.init();
  const global: ServerEvent[] = [];
  service.registry.onGlobal((threadId, ev) => {
    if (threadId === "t") global.push(ev);
  });
  await service.startRun({ threadId: "t", yaml: graph(fn), input: {} });
  // close() waits for the run in flight to finish.
  await service.close();
  return { live: service.registry.get("t")?.events ?? [], global, journal: loadEventJournal(dir, "t") };
}

const errorEvents = (events: ServerEvent[]) => events.filter((e) => e.type === "node.error" || e.type === "run.error");

describe("errors in run events", () => {
  it("a system error reaches no client path; each event has an error id matching a log line with the detail", async () => {
    const log = captureErrorLog();
    const { live, global, journal } = await runToEnd("eventErrorsFsFail");

    for (const events of [live, global, journal]) {
      expect(errorEvents(events).map((e) => e.type)).toEqual(expect.arrayContaining(["node.error", "run.error"]));
      const text = JSON.stringify(events);
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(/EACCES|permission denied/);
    }
    for (const ev of errorEvents(live)) {
      const data = ev.data as Record<string, unknown>;
      expect(data["errorId"]).toMatch(/^err_[0-9a-f]{12}$/);
      for (const f of ["message", "error"]) {
        if (f in data) expect(data[f]).toBe(`Internal server error (error id ${String(data["errorId"])})`);
      }
      const entry = log.find((l) => l["errorId"] === data["errorId"]);
      expect(entry).toMatchObject({ msg: "run.event.error", threadId: "t", eventType: ev.type });
      expect(JSON.stringify(entry)).toContain(`EACCES: permission denied, open '${SECRET}'`);
    }
    expect(errorEvents(journal).map((e) => (e.data as Record<string, unknown>)["errorId"])).toEqual(
      errorEvents(live).map((e) => (e.data as Record<string, unknown>)["errorId"]),
    );
  });

  it("an error from the graph's own node keeps its message", async () => {
    captureErrorLog();
    const { live, journal } = await runToEnd("eventErrorsOwnFail");
    for (const events of [live, journal]) {
      const nodeError = events.find((e) => e.type === "node.error");
      expect(String((nodeError?.data as Record<string, unknown>)["error"])).toContain("order 42 has no customer");
      for (const ev of errorEvents(events)) expect(ev.data).not.toHaveProperty("errorId");
    }
  });

  it("recognises file-system and network error text, and nothing else", () => {
    expect(isSystemErrorText(`Error: EACCES: permission denied, open '${SECRET}'`)).toBe(true);
    expect(isSystemErrorText("wait timeout resume failed: ENOENT: no such file or directory, scandir '/var/x'")).toBe(true);
    expect(isSystemErrorText("connect ECONNREFUSED 10.0.0.5:5432")).toBe(true);
    expect(isSystemErrorText("getaddrinfo ENOTFOUND db.internal")).toBe(true);
    expect(isSystemErrorText("order 42 has no customer")).toBe(false);
    expect(isSystemErrorText("ERROR: value too long, retry")).toBe(false);
    expect(isSystemErrorText("Node n failed: EXPECTED a number")).toBe(false);
  });

  it("redacts every error field of an event and leaves other events alone", () => {
    const log = captureErrorLog();
    const base = { id: "e", ts: "", runId: "r", threadId: "t", graph: "g", scope: {}, seq: 1 };
    const text = `ENOSPC: no space left on device, write '${SECRET}'`;
    const out = redactEventErrors("t", { ...base, type: "run.error", data: { message: text, error: text, durationMs: 3 } } as ServerEvent);
    const data = out.data as Record<string, unknown>;
    expect(data).toEqual({ message: expect.stringMatching(/^Internal server error \(error id err_/), error: data["message"], durationMs: 3, errorId: expect.any(String) });
    expect(log).toEqual([expect.objectContaining({ msg: "run.event.error", errorId: data["errorId"], message: text, error: text })]);

    const output = { ...base, type: "node.output", data: { text } } as ServerEvent;
    expect(redactEventErrors("t", output)).toBe(output);
  });

  it("a run failure the server catches itself is redacted when it is a system error", () => {
    expect(runErrorMessage(eacces(), "err_1")).toEqual({ message: "Internal server error (error id err_1)", redacted: true });
    expect(runErrorMessage(new Error("order 42 has no customer"), "err_1")).toEqual({ message: "order 42 has no customer", redacted: false });
  });
});
