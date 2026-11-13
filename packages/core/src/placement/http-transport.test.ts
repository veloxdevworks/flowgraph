import { describe, it, expect } from "vitest";
import type { GraphSpec } from "@flowgraph/spec";
import { createHttpTransport } from "./http-transport.js";

const target = { name: "studio", url: "https://studio.lan:8787/", token: "env:STUDIO_TOKEN" };
const spec = { apiVersion: "flowgraph/v1", kind: "Graph", metadata: { name: "g" }, nodes: [], edges: [] } as unknown as GraphSpec;

function stub(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  }) as typeof fetch;
  return { fetchFn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createHttpTransport", () => {
  it("GETs /worker/labels with the bearer token", async () => {
    process.env["STUDIO_TOKEN"] = "tok-1";
    const { fetchFn, calls } = stub(() => json({ labels: ["os:linux"], checks: {}, flowgraphVersion: "1.2.3" }));
    const labels = await createHttpTransport({ fetch: fetchFn }).labels(target);
    expect(labels.labels).toEqual(["os:linux"]);
    expect(calls[0]!.url).toBe("https://studio.lan:8787/worker/labels");
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-1");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("POSTs the spec and input to /worker/preflight", async () => {
    process.env["STUDIO_TOKEN"] = "tok-1";
    const { fetchFn, calls } = stub(() => json({ ok: false, diagnostics: [{ severity: "error", code: "BIN_NOT_FOUND", message: "x" }] }));
    const r = await createHttpTransport({ fetch: fetchFn }).preflight(target, { spec, input: { a: 1 } });
    expect(r.ok).toBe(false);
    expect(calls[0]!.url).toBe("https://studio.lan:8787/worker/preflight");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ spec, input: { a: 1 } });
  });

  it("omits the Authorization header when the target has no token", async () => {
    const { fetchFn, calls } = stub(() => json({ labels: [], flowgraphVersion: "1" }));
    await createHttpTransport({ fetch: fetchFn }).labels({ name: "open", url: "http://x" });
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("turns HTTP errors, network errors, bad bodies and timeouts into clear errors", async () => {
    const t = { name: "w", url: "http://w" };
    await expect(createHttpTransport({ fetch: stub(() => json({ error: "nope" }, 401)).fetchFn }).labels(t)).rejects.toThrow(/returned 401: nope/);
    await expect(createHttpTransport({ fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch }).labels(t)).rejects.toThrow(/failed: ECONNREFUSED/);
    await expect(createHttpTransport({ fetch: stub(() => new Response("<html>")).fetchFn }).labels(t)).rejects.toThrow(/non-JSON/);
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    await expect(createHttpTransport({ fetch: hang, timeoutMs: 20 }).labels(t)).rejects.toThrow(/timed out after 20ms/);
  });

  it("rejects an unset token env var", async () => {
    delete process.env["NO_SUCH_TOKEN_VAR"];
    await expect(createHttpTransport({ fetch: stub(() => json({})).fetchFn }).labels({ name: "w", url: "http://w", token: "env:NO_SUCH_TOKEN_VAR" })).rejects.toThrow(/NO_SUCH_TOKEN_VAR/);
  });
});

const w = { name: "w", url: "http://w:1" };
const sse = (frames: Array<{ seq?: number; type: string; data?: unknown } | ":ping">, opts: { drop?: boolean } = {}) => {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const f of frames) {
          if (f === ":ping") c.enqueue(enc.encode(": ping\n\n"));
          else c.enqueue(enc.encode(`id: ${f.seq ?? -1}\nevent: engine\ndata: ${JSON.stringify(f)}\n\n`));
        }
        if (!opts.drop) c.close();
      },
      pull(c) {
        if (opts.drop) c.error(new Error("socket hang up"));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};
const fast = { reconnectDelayMs: 1, maxReconnects: 3 };

describe("dispatch", () => {
  it("POSTs the spec as JSON-in-yaml with the child thread id", async () => {
    const { fetchFn, calls } = stub(() => json({ threadId: "p/n/1", runId: "r", status: "started" }, 202));
    const r = await createHttpTransport({ fetch: fetchFn }).dispatch(w, { childThreadId: "p/n/1", spec, input: { a: 1 }, label: "L" });
    expect(r).toEqual({ status: "started" });
    expect(calls[0]!.url).toBe("http://w:1/runs");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({ threadId: "p/n/1", input: { a: 1 }, label: "L" });
    expect(JSON.parse(body.yaml)).toEqual(spec);
  });

  it("maps 409 THREAD_EXISTS to exists, and other failures to errors naming the target", async () => {
    const exists = stub(() => json({ error: "x", code: "THREAD_EXISTS", threadId: "t", status: "running", active: true }, 409));
    expect(await createHttpTransport({ fetch: exists.fetchFn }).dispatch(w, { childThreadId: "t", spec })).toEqual({ status: "exists", runStatus: "running", active: true });
    const other = stub(() => json({ error: "collides", code: "THREAD_ID_CONFLICT" }, 409));
    await expect(createHttpTransport({ fetch: other.fetchFn }).dispatch(w, { childThreadId: "t", spec })).rejects.toThrow(/"w".*409.*THREAD_ID_CONFLICT/);
    const auth = stub(() => json({ error: "unauthorized" }, 401));
    await expect(createHttpTransport({ fetch: auth.fetchFn }).dispatch(w, { childThreadId: "t", spec })).rejects.toThrow(/"w" returned 401: unauthorized/);
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    await expect(createHttpTransport({ fetch: down }).dispatch(w, { childThreadId: "t", spec })).rejects.toThrow(/"w" failed: ECONNREFUSED/);
  });
});

describe("cancel and resume", () => {
  it("cancel is idempotent for finished or unknown runs", async () => {
    const calls: string[] = [];
    const t = (status: number, body: unknown) => createHttpTransport({ fetch: (async (u: string) => (calls.push(u), json(body, status))) as unknown as typeof fetch });
    await t(200, { status: "cancelled" }).cancel(w, "p/n/1");
    await t(200, { status: "completed" }).cancel(w, "p/n/1");
    await t(404, { error: "No run" }).cancel(w, "p/n/1");
    await t(400, { error: 'No active session for thread "x"' }).cancel(w, "p/n/1");
    expect(calls[0]).toBe("http://w:1/runs/p%2Fn%2F1/cancel");
    await expect(t(500, { error: "boom" }).cancel(w, "x")).rejects.toThrow(/500/);
    await expect(t(401, { error: "no" }).cancel(w, "x")).rejects.toThrow(/401/);
  });

  it("resume POSTs { resume }", async () => {
    const { fetchFn, calls } = stub(() => json({ status: "started" }, 202));
    await createHttpTransport({ fetch: fetchFn }).resume(w, "p/n/1", { approved: true });
    expect(calls[0]!.url).toBe("http://w:1/runs/p%2Fn%2F1/resume");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ resume: { approved: true } });
  });
});

describe("attach", () => {
  const collect = async (a: { events: AsyncIterable<{ type: string; seq?: number }> }) => {
    const out: string[] = [];
    for await (const e of a.events) out.push(`${e.seq}:${e.type}`);
    return out;
  };

  it("streams events to the terminal event and returns run.end state", async () => {
    const { fetchFn, calls } = stub(() => sse([":ping", { seq: 1, type: "run.start" }, { seq: 2, type: "node.end" }, { seq: 3, type: "run.end", data: { state: { out: 7 } } }]));
    const a = createHttpTransport({ fetch: fetchFn }).attach(w, "p/n/1");
    expect(await collect(a)).toEqual(["1:run.start", "2:node.end", "3:run.end"]);
    expect(await a.result).toEqual({ status: "completed", state: { out: 7 }, lastSeq: 3 });
    expect(calls.find((c) => c.url.includes("/events"))!.url).toBe("http://w:1/runs/p%2Fn%2F1/events?afterSeq=-1");
  });

  it("works when only result is awaited, and for an already finished run (replay)", async () => {
    const { fetchFn } = stub(() => sse([{ seq: 1, type: "run.start" }, { seq: 2, type: "run.end", data: { state: { v: 1 } } }]));
    const r = await createHttpTransport({ fetch: fetchFn }).attach(w, "t", { afterSeq: 0 }).result;
    expect(r.state).toEqual({ v: 1 });
  });

  it("reports run.error with its message and fetches state best effort", async () => {
    const { fetchFn, calls } = stub((url) =>
      url.includes("/events") ? sse([{ seq: 1, type: "run.error", data: { message: "kaboom" } }]) : json({ state: { values: { partial: 1 }, next: [], interrupts: [] } }),
    );
    const r = await createHttpTransport({ fetch: fetchFn }).attach(w, "t").result;
    expect(r).toMatchObject({ status: "error", error: { message: "kaboom" }, state: { partial: 1 } });
    expect(calls.some((c) => c.url === "http://w:1/runs/t/state")).toBe(true);
  });

  it("maps run.aborted to cancelled and the run-level interrupt to interrupted", async () => {
    const tr = (frames: Parameters<typeof sse>[0]) => createHttpTransport({ fetch: stub((u) => (u.includes("/events") ? sse(frames) : json({ state: null }))).fetchFn });
    expect((await tr([{ seq: 1, type: "run.aborted", data: { message: "x" } }]).attach(w, "t").result).status).toBe("cancelled");
    const r = await tr([
      { seq: 1, type: "interrupt.raised", data: { id: "node-level" } },
      { seq: 2, type: "interrupt.raised", data: { interrupts: [{ id: "i1", reason: "approve" }] } },
    ]).attach(w, "t").result;
    expect(r).toMatchObject({ status: "interrupted", interrupts: [{ id: "i1", reason: "approve" }], lastSeq: 2 });
  });

  it("reconnects with afterSeq after a dropped stream, without duplicating events", async () => {
    let n = 0;
    const { fetchFn, calls } = stub((u) => {
      if (!u.includes("/events")) return json({ status: "running", active: true });
      n++;
      if (n === 1) return sse([{ seq: 1, type: "a" }, { seq: 2, type: "b" }], { drop: true });
      // server replays from seq 1 (overlap) then continues
      return sse([{ seq: 2, type: "b" }, { seq: 3, type: "c" }, { seq: 4, type: "run.end", data: { state: {} } }]);
    });
    const a = createHttpTransport({ fetch: fetchFn, ...fast }).attach(w, "t");
    expect(await collect(a)).toEqual(["1:a", "2:b", "3:c", "4:run.end"]);
    expect((await a.result).status).toBe("completed");
    expect(calls.filter((c) => c.url.includes("/events")).map((c) => c.url.split("?")[1])).toEqual(["afterSeq=-1", "afterSeq=2"]);
  });

  it("gives up after bounded retries", async () => {
    const { fetchFn, calls } = stub(() => { throw new Error("ECONNRESET"); });
    await expect(createHttpTransport({ fetch: fetchFn, ...fast }).attach(w, "t").result).rejects.toThrow(/lost its event stream after 3 reconnects.*ECONNRESET/);
    expect(calls.filter((c) => c.url.includes("/events")).length).toBe(4);
  });

  it("treats a stream that closes early as finished when the run is no longer active", async () => {
    const { fetchFn } = stub((u) =>
      u.includes("/events") ? sse([{ seq: 1, type: "run.start" }]) : u.endsWith("/state") ? json({ state: { values: { z: 1 }, next: [], interrupts: [] } }) : json({ status: "cancelled", active: false }),
    );
    const r = await createHttpTransport({ fetch: fetchFn, ...fast }).attach(w, "t").result;
    expect(r).toMatchObject({ status: "cancelled", state: { z: 1 } });
  });

  it("fails fast on 401 and 404 from the event stream", async () => {
    const { fetchFn, calls } = stub(() => json({ error: "unauthorized" }, 401));
    await expect(createHttpTransport({ fetch: fetchFn, ...fast }).attach(w, "t").result).rejects.toThrow(/"w".*401: unauthorized/);
    expect(calls.length).toBe(1);
  });

  it("reads the journal of a run that already finished instead of opening a stream", async () => {
    const { fetchFn, calls } = stub((u) =>
      u.endsWith("/journal")
        ? json({ events: [
            { seq: 1, type: "interrupt.raised", data: { interrupts: [{ id: "old" }] } },
            { seq: 2, type: "run.start" },
            { seq: 3, type: "run.end", data: { state: { v: 2 } } },
          ] })
        : json({ status: "completed", active: false }),
    );
    const a = createHttpTransport({ fetch: fetchFn }).attach(w, "p/n/1");
    expect((await collect(a)).length).toBe(3);
    expect(await a.result).toEqual({ status: "completed", state: { v: 2 }, lastSeq: 3 });
    expect(calls.some((c) => c.url.includes("/events"))).toBe(false);
    // afterSeq filters the replay
    const b = createHttpTransport({ fetch: fetchFn }).attach(w, "p/n/1", { afterSeq: 2 });
    expect(await collect(b)).toEqual(["3:run.end"]);
  });

  it("an errored finished run carries the run.error message", async () => {
    const { fetchFn } = stub((u) =>
      u.endsWith("/journal") ? json({ events: [{ seq: 1, type: "run.error", data: { message: "bad input" } }] }) : u.endsWith("/state") ? json({ state: null }) : json({ status: "error", active: false }),
    );
    expect(await createHttpTransport({ fetch: fetchFn }).attach(w, "t").result).toMatchObject({ status: "error", error: { message: "bad input" } });
  });

  it("fails on an unknown thread (404) instead of waiting on an empty stream", async () => {
    const { fetchFn, calls } = stub(() => json({ error: 'No run "t"' }, 404));
    await expect(createHttpTransport({ fetch: fetchFn }).attach(w, "t").result).rejects.toThrow(/"w" returned 404/);
    expect(calls.length).toBe(1);
  });

  it("abort stops the stream without calling cancel", async () => {
    const calls: string[] = [];
    const hang = ((u: string, init: RequestInit) => {
      calls.push(`${init.method} ${u}`);
      return new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }) as unknown as typeof fetch;
    const ac = new AbortController();
    const a = createHttpTransport({ fetch: hang, ...fast, timeoutMs: 60_000 }).attach(w, "t", { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(a.result).rejects.toMatchObject({ name: "AbortError" });
    expect(await collect(a)).toEqual([]);
    expect(calls.some((c) => c.includes("/cancel"))).toBe(false);
  });
});
