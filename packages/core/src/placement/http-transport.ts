/**
 * Direct WorkerTransport (ADR-0020 §9): the coordinator calls a worker's REST API.
 *
 * Artifacts stream: `HEAD /worker/artifacts/:sha256`, `PUT /worker/artifacts/:sha256` (raw bytes) and
 * `GET /worker/runs/:threadId/artifacts/:sha256`. They are not subject to `timeoutMs`; a transfer is
 * abandoned after `artifactIdleTimeoutMs` without progress.
 *
 * Wire format: `GET {url}/worker/labels` and `POST {url}/worker/preflight` with `{ spec, input? }`
 * (the server also accepts `{ yaml }`), authenticated with the target's bearer token.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveTargetToken } from "./topology.js";
import type {
  ArtifactDownload,
  ArtifactSource,
  ArtifactTransferOptions,
  AttachOptions,
  DispatchRequest,
  DispatchResult,
  PreflightRequest,
  PreflightResult,
  TransportTarget,
  WorkerEvent,
  WorkerLabels,
  WorkerOutcome,
  WorkerRunAttachment,
  WorkerTransport,
} from "./transport.js";

export interface HttpTransportOptions {
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout; default 15000. */
  timeoutMs?: number;
  /** Consecutive failed SSE (re)connects before `attach` gives up; default 5. Reset by any received event. */
  maxReconnects?: number;
  /** First reconnect delay; doubles per attempt up to 5000ms. Default 250. */
  reconnectDelayMs?: number;
  /** An SSE stream silent for this long (the server pings every 15s) is treated as dropped; default 45000. */
  idleTimeoutMs?: number;
  /** An artifact transfer that moves no bytes for this long is aborted; default 60000. */
  artifactIdleTimeoutMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

function abortErrorFor(target: TransportTarget, what: string): Error {
  return Object.assign(new Error(`${what} on "${target.name}" was aborted`), { name: "AbortError" });
}

function abortError(target: TransportTarget, childThreadId: string): Error {
  return Object.assign(new Error(`attach to "${childThreadId}" on "${target.name}" was aborted`), { name: "AbortError" });
}

/** Terminal-event mapping; mirrors the server's `isTerminalEvent`. */
function terminalOutcome(ev: WorkerEvent): WorkerOutcome | undefined {
  const data = (ev.data ?? {}) as { message?: string; error?: string; state?: Record<string, unknown>; interrupts?: unknown };
  switch (ev.type) {
    case "run.end":
      return { status: "completed", ...(data.state && typeof data.state === "object" ? { state: data.state } : {}) };
    case "run.error":
      return { status: "error", error: { message: data.message ?? data.error ?? "child run failed" } };
    case "run.aborted":
      return { status: "cancelled" };
    case "run.paused":
      return { status: "interrupted", interrupts: [] };
    case "interrupt.raised":
      return Array.isArray(data.interrupts) ? { status: "interrupted", interrupts: data.interrupts } : undefined;
    default:
      return undefined;
  }
}

/** Parse an SSE byte stream into `{ id, event, data }` frames. */
async function* sseFrames(body: ReadableStream<Uint8Array>, onChunk: () => void): AsyncGenerator<{ id?: string; event?: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onChunk();
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let id: string | undefined;
        let event: string | undefined;
        const data: string[] = [];
        for (const line of raw.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const c = line.indexOf(":");
          const field = c < 0 ? line : line.slice(0, c);
          const val = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
          if (field === "id") id = val;
          else if (field === "event") event = val;
          else if (field === "data") data.push(val);
        }
        if (data.length) yield { ...(id !== undefined ? { id } : {}), ...(event !== undefined ? { event } : {}), data: data.join("\n") };
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

export function createHttpTransport(opts: HttpTransportOptions = {}): WorkerTransport {
  const timeoutMs = opts.timeoutMs ?? 15_000;

  function headersFor(target: TransportTarget, accept: string, hasBody: boolean): Record<string, string> {
    const token = resolveTargetToken(target);
    const headers: Record<string, string> = { Accept: accept };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (hasBody) headers["Content-Type"] = "application/json";
    return headers;
  }
  const urlFor = (target: TransportTarget, path: string) => `${target.url.replace(/\/+$/, "")}${path}`;
  const runPath = (id: string, tail = "") => `/runs/${encodeURIComponent(id)}${tail}`;

  /** One JSON request. `accept` lists non-2xx statuses returned instead of thrown. */
  async function request(
    target: TransportTarget,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    accept: number[] = [],
    signal?: AbortSignal,
  ): Promise<{ status: number; json: unknown }> {
    const doFetch = opts.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(urlFor(target, path), {
        method,
        headers: headersFor(target, "application/json", body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (signal?.aborted) throw abortError(target, path);
      if (e.name === "TimeoutError" || e.name === "AbortError") throw new Error(`${method} ${path} on "${target.name}" timed out after ${timeoutMs}ms`);
      throw new Error(`${method} ${path} on "${target.name}" failed: ${e.message}`);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok && !accept.includes(res.status)) {
      const j = json as { error?: string; code?: string } | undefined;
      const detail = j?.error ?? text.slice(0, 200);
      throw Object.assign(new Error(`${method} ${path} on "${target.name}" returned ${res.status}${detail ? `: ${detail}` : ""}${j?.code ? ` (${j.code})` : ""}`), { status: res.status });
    }
    if (json === undefined) throw new Error(`${method} ${path} on "${target.name}" returned a non-JSON body`);
    return { status: res.status, json };
  }
  const call = async <T>(target: TransportTarget, method: "GET" | "POST", path: string, body?: unknown): Promise<T> =>
    (await request(target, method, path, body)).json as T;

  async function dispatch(target: TransportTarget, req: DispatchRequest): Promise<DispatchResult> {
    // JSON is valid YAML, and the server accepts what preflight accepts.
    const body = {
      threadId: req.childThreadId,
      yaml: JSON.stringify(req.spec),
      ...(req.input ? { input: req.input } : {}),
      ...(req.label ? { label: req.label } : {}),
    };
    const r = await request(target, "POST", "/runs", body, [409]);
    if (r.status !== 409) return { status: "started" };
    const j = r.json as { code?: string; status?: string; active?: boolean; error?: string };
    if (j.code === "THREAD_EXISTS") return { status: "exists", runStatus: j.status ?? "unknown", active: Boolean(j.active) };
    throw new Error(`POST /runs on "${target.name}" returned 409: ${j.error ?? "conflict"}${j.code ? ` (${j.code})` : ""}`);
  }

  /** Final state channels of a thread; undefined when unavailable. */
  async function fetchState(target: TransportTarget, id: string): Promise<{ values?: Record<string, unknown>; interrupts?: unknown[] }> {
    try {
      const j = (await request(target, "GET", runPath(id, "/state"))).json as { state?: { values?: Record<string, unknown>; interrupts?: unknown[] } | null };
      return j.state ?? {};
    } catch {
      return {};
    }
  }

  async function fetchStatus(target: TransportTarget, id: string, signal?: AbortSignal): Promise<{ status: string; active: boolean }> {
    const j = (await request(target, "GET", runPath(id), undefined, [], signal)).json as { status?: string; active?: boolean };
    return { status: j.status ?? "unknown", active: Boolean(j.active) };
  }

  function attach(target: TransportTarget, childThreadId: string, aopts: AttachOptions = {}): WorkerRunAttachment {
    const maxReconnects = opts.maxReconnects ?? 5;
    const baseDelay = opts.reconnectDelayMs ?? 250;
    const idleMs = opts.idleTimeoutMs ?? 45_000;
    const doFetch = opts.fetch ?? globalThis.fetch;
    const outer = aopts.signal;

    const queue: WorkerEvent[] = [];
    let ended = false;
    let wake: (() => void) | undefined;
    const notify = () => {
      const w = wake;
      wake = undefined;
      w?.();
    };
    let resolveResult!: (o: WorkerOutcome) => void;
    let rejectResult!: (e: Error) => void;
    const result = new Promise<WorkerOutcome>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    result.catch(() => undefined); // consumers may only iterate events

    let lastSeq = aopts.afterSeq ?? -1;

    async function finishFromServer(): Promise<WorkerOutcome | undefined> {
      // The stream closed without a terminal event: use the run's recorded status.
      const st = await fetchStatus(target, childThreadId);
      if (st.active) return undefined;
      const status = STATUS_MAP[st.status];
      if (!status) return undefined;
      return status === "error" ? { status, error: { message: `child run "${childThreadId}" on "${target.name}" ended with status error` } } : { status };
    }

    const STATUS_MAP: Record<string, WorkerOutcome["status"] | undefined> = {
      completed: "completed",
      interrupted: "interrupted",
      paused: "interrupted",
      error: "error",
      cancelled: "cancelled",
    };

    /** A run that is not executing: read its journal instead of opening a stream that would never close. */
    async function settled(status: string): Promise<WorkerOutcome | undefined> {
      const fallback = STATUS_MAP[status];
      if (!fallback) return undefined;
      let journal: WorkerEvent[];
      try {
        journal = ((await request(target, "GET", runPath(childThreadId, "/journal"))).json as { events?: WorkerEvent[] }).events ?? [];
      } catch {
        return undefined; // fall back to the stream
      }
      let terminal: WorkerOutcome | undefined;
      for (const ev of journal) {
        const seq = typeof ev.seq === "number" ? ev.seq : -1;
        if (seq >= 0 && seq <= lastSeq) continue;
        queue.push(ev);
        if (seq >= 0) lastSeq = seq;
        // The last terminal event wins: a gate that was resumed has an earlier, stale one.
        terminal = terminalOutcome(ev) ?? terminal;
      }
      notify();
      const out: WorkerOutcome = terminal && terminal.status === fallback ? terminal : fallback === "error" ? { status: "error", error: { message: terminal?.error?.message ?? `child run "${childThreadId}" on "${target.name}" ended with status error` } } : { status: fallback };
      if (out.status === "completed" && out.state) return { ...out, lastSeq };
      const snap = await fetchState(target, childThreadId);
      return {
        ...out,
        ...(snap.values ? { state: snap.values } : {}),
        ...(out.status === "interrupted" && !out.interrupts?.length && snap.interrupts ? { interrupts: snap.interrupts } : {}),
        lastSeq,
      };
    }

    async function pump(): Promise<WorkerOutcome> {
      let failures = 0;
      try {
        const st = await fetchStatus(target, childThreadId, outer);
        if (!st.active) {
          const done = await settled(st.status);
          if (done) return done;
        }
      } catch (err) {
        // An unknown thread would otherwise hang on an empty live stream; other failures are retried below.
        if (outer?.aborted) throw abortError(target, childThreadId);
        if ((err as { status?: number }).status) throw err;
      }
      for (;;) {
        if (outer?.aborted) throw abortError(target, childThreadId);
        const conn = new AbortController();
        const onOuter = () => conn.abort();
        outer?.addEventListener("abort", onOuter, { once: true });
        let idle: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => conn.abort(), idleMs);
        };
        let fatal: Error | undefined;
        let terminal: WorkerOutcome | undefined;
        try {
          arm();
          let res: Response;
          const headerTimer = setTimeout(() => conn.abort(), timeoutMs);
          try {
            res = await doFetch(urlFor(target, runPath(childThreadId, `/events?afterSeq=${lastSeq}`)), {
              method: "GET",
              headers: headersFor(target, "text/event-stream", false),
              signal: conn.signal,
            });
          } finally {
            clearTimeout(headerTimer);
          }
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            let detail = text.slice(0, 200);
            try {
              const j = JSON.parse(text) as { error?: string; code?: string };
              detail = `${j.error ?? detail}${j.code ? ` (${j.code})` : ""}`;
            } catch {
              /* keep raw text */
            }
            const e = new Error(`GET /runs/:id/events on "${target.name}" returned ${res.status}${detail ? `: ${detail}` : ""}`);
            if (res.status >= 400 && res.status < 500) fatal = e;
            else throw e;
          } else if (!res.body) {
            throw new Error(`GET /runs/:id/events on "${target.name}" returned no body`);
          } else {
            for await (const frame of sseFrames(res.body, arm)) {
              let ev: WorkerEvent;
              try {
                ev = JSON.parse(frame.data) as WorkerEvent;
              } catch {
                continue;
              }
              failures = 0;
              const seq = typeof ev.seq === "number" ? ev.seq : -1;
              if (seq >= 0) {
                if (seq <= lastSeq) continue; // replayed after a reconnect
                lastSeq = seq;
              }
              queue.push(ev);
              notify();
              terminal = terminalOutcome(ev);
              if (terminal) break;
            }
          }
        } catch (err) {
          if (outer?.aborted) throw abortError(target, childThreadId);
          const e = err as Error;
          if (++failures > maxReconnects) {
            throw new Error(`attach to "${childThreadId}" on "${target.name}" lost its event stream after ${maxReconnects} reconnects: ${e.name === "AbortError" ? "stream stalled or timed out" : e.message}`);
          }
        } finally {
          if (idle) clearTimeout(idle);
          outer?.removeEventListener("abort", onOuter);
          conn.abort();
        }
        if (fatal) throw fatal;
        if (outer?.aborted) throw abortError(target, childThreadId);

        if (terminal) {
          if (terminal.status === "completed" && terminal.state) return { ...terminal, lastSeq };
          const snap = await fetchState(target, childThreadId);
          return {
            ...terminal,
            ...(snap.values ? { state: snap.values } : {}),
            ...(terminal.status === "interrupted" && !(terminal.interrupts?.length) && snap.interrupts ? { interrupts: snap.interrupts } : {}),
            lastSeq,
          };
        }

        // Stream ended (or dropped) without a terminal event: finished already, or reconnect.
        try {
          const done = await finishFromServer();
          if (done) {
            const snap = await fetchState(target, childThreadId);
            return { ...done, ...(snap.values ? { state: snap.values } : {}), ...(snap.interrupts && done.status === "interrupted" ? { interrupts: snap.interrupts } : {}), lastSeq };
          }
        } catch {
          // Status unreachable: the next stream attempt decides (failed attempts are counted there).
        }
        await sleep(Math.min(5000, baseDelay * 2 ** Math.min(failures, 5)), outer);
      }
    }

    pump().then(
      (o) => {
        ended = true;
        notify();
        resolveResult(o);
      },
      (e: Error) => {
        ended = true;
        notify();
        rejectResult(e);
      },
    );

    const events: AsyncIterable<WorkerEvent> = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift()!;
          if (ended) return;
          await new Promise<void>((r) => {
            wake = r;
            if (queue.length || ended) notify();
          });
        }
      },
    };
    return { events, result };
  }

  async function cancel(target: TransportTarget, childThreadId: string): Promise<void> {
    // A finished or unknown run has nothing to cancel: 404, and the server's 400 "No active session"
    // for a finished run it no longer holds in memory, both count as done.
    const r = await request(target, "POST", runPath(childThreadId, "/cancel"), {}, [404, 400]);
    if (r.status === 400) {
      const msg = String((r.json as { error?: string }).error ?? "");
      if (!/No active session/i.test(msg)) throw new Error(`POST /runs/:id/cancel on "${target.name}" returned 400: ${msg}`);
    }
  }

  async function resume(target: TransportTarget, childThreadId: string, value: unknown): Promise<void> {
    await call(target, "POST", runPath(childThreadId, "/resume"), { resume: value });
  }

  const artifactIdleMs = opts.artifactIdleTimeoutMs ?? 60_000;

  /** An abort signal that also fires after `artifactIdleMs` without `touch()`; `stop()` clears the timer. */
  function idleGuard(outer?: AbortSignal) {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    const touch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        ac.abort();
      }, artifactIdleMs);
    };
    const onOuter = () => ac.abort();
    if (outer?.aborted) ac.abort();
    else outer?.addEventListener("abort", onOuter, { once: true });
    touch();
    return {
      signal: ac.signal,
      touch,
      get stalled() {
        return stalled;
      },
      stop() {
        if (timer) clearTimeout(timer);
        outer?.removeEventListener("abort", onOuter);
      },
    };
  }

  const failureOf = async (target: TransportTarget, what: string, res: Response): Promise<Error> => {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 200);
    let code = "";
    try {
      const j = JSON.parse(text) as { error?: string; code?: string };
      detail = j.error ?? detail;
      code = j.code ? ` (${j.code})` : "";
    } catch {
      /* keep raw text */
    }
    return Object.assign(new Error(`${what} on "${target.name}" returned ${res.status}${detail ? `: ${detail}` : ""}${code}`), { status: res.status, ...(code ? { code: code.slice(2, -1) } : {}) });
  };

  const transferError = (target: TransportTarget, what: string, err: unknown, guard: { stalled: boolean }, outer?: AbortSignal): Error => {
    if (outer?.aborted) return Object.assign(new Error(`${what} on "${target.name}" was aborted`), { name: "AbortError" });
    if (guard.stalled) return new Error(`${what} on "${target.name}" stalled: no data for ${artifactIdleMs}ms`);
    return err instanceof Error && (err as { status?: number }).status ? err : new Error(`${what} on "${target.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
  };

  const artifactPath = (sha256: string) => `/worker/artifacts/${encodeURIComponent(sha256)}`;

  async function hasArtifact(target: TransportTarget, sha256: string, o: ArtifactTransferOptions = {}): Promise<boolean> {
    const doFetch = opts.fetch ?? globalThis.fetch;
    const what = `HEAD ${artifactPath(sha256)}`;
    let res: Response;
    try {
      res = await doFetch(urlFor(target, artifactPath(sha256)), {
        method: "HEAD",
        headers: headersFor(target, "application/json", false),
        signal: o.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), o.signal]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (o.signal?.aborted) throw abortErrorFor(target, what);
      throw new Error(`${what} on "${target.name}" failed: ${(err as Error).message}`);
    }
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    // HEAD has no body, so the status is all there is to report.
    throw Object.assign(new Error(`${what} on "${target.name}" returned ${res.status}`), { status: res.status });
  }

  async function putArtifact(target: TransportTarget, sha256: string, file: string, o: ArtifactTransferOptions = {}): Promise<void> {
    const doFetch = opts.fetch ?? globalThis.fetch;
    const what = `PUT ${artifactPath(sha256)}`;
    const size = (await stat(file)).size;
    const guard = idleGuard(o.signal);
    try {
      async function* chunks(): AsyncGenerator<Buffer> {
        for await (const chunk of createReadStream(file)) {
          guard.touch();
          yield chunk as Buffer;
        }
      }
      const body = Readable.toWeb(Readable.from(chunks())) as unknown as ReadableStream<Uint8Array>;
      const headers = headersFor(target, "application/json", false);
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Length"] = String(size);
      const res = await doFetch(urlFor(target, artifactPath(sha256)), {
        method: "PUT",
        headers,
        body,
        // Node's fetch needs this to send a stream.
        duplex: "half",
        signal: guard.signal,
      } as RequestInit);
      if (!res.ok) throw await failureOf(target, what, res);
      await res.arrayBuffer().catch(() => undefined);
    } catch (err) {
      throw transferError(target, what, err, guard, o.signal);
    } finally {
      guard.stop();
    }
  }

  async function getArtifact(target: TransportTarget, source: ArtifactSource, destFile: string, o: ArtifactTransferOptions = {}): Promise<ArtifactDownload> {
    const doFetch = opts.fetch ?? globalThis.fetch;
    const path = `/worker${runPath(source.threadId, `/artifacts/${encodeURIComponent(source.sha256)}`)}`;
    const what = `GET ${path}`;
    const guard = idleGuard(o.signal);
    try {
      const res = await doFetch(urlFor(target, path), {
        method: "GET",
        headers: headersFor(target, "application/octet-stream", false),
        signal: guard.signal,
      });
      if (!res.ok) throw await failureOf(target, what, res);
      if (!res.body) throw new Error(`${what} on "${target.name}" returned no body`);
      const hash = createHash("sha256");
      let sizeBytes = 0;
      await pipeline(
        Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
        new Transform({
          transform(chunk: Buffer, _e, cb) {
            guard.touch();
            hash.update(chunk);
            sizeBytes += chunk.length;
            cb(null, chunk);
          },
        }),
        createWriteStream(destFile),
      );
      return { sha256: hash.digest("hex"), sizeBytes };
    } catch (err) {
      throw transferError(target, what, err, guard, o.signal);
    } finally {
      guard.stop();
    }
  }

  return {
    labels: (target) => call<WorkerLabels>(target, "GET", "/worker/labels"),
    preflight: (target, req: PreflightRequest) =>
      call<PreflightResult>(target, "POST", "/worker/preflight", { spec: req.spec, ...(req.input ? { input: req.input } : {}) }),
    dispatch,
    attach,
    resume,
    cancel,
    hasArtifact,
    putArtifact,
    getArtifact,
  };
}
