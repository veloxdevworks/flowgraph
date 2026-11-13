/** WorkerTransport (ADR-0020 §9): the interface, and a scriptable fake for tests. */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Diagnostic, GraphSpec } from "@flowgraph/spec";
import type { LabelCheckResult } from "./labels.js";
import type { TopologyTarget } from "./topology.js";

export type TransportTarget = { name: string } & TopologyTarget;

export interface WorkerLabels {
  labels: string[];
  checks?: Record<string, LabelCheckResult>;
  flowgraphVersion: string;
}

export interface PreflightRequest {
  spec: GraphSpec;
  input?: Record<string, unknown>;
}
export interface PreflightResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}

export interface DispatchRequest {
  /** `{parentThreadId}/{nodeId}/{attempt}`. Sent as the worker's thread id; `/` is URL-encoded in paths. */
  childThreadId: string;
  spec: GraphSpec;
  input?: Record<string, unknown>;
  /** Human label shown in the worker's run list. */
  label?: string;
}
/**
 * `started`: the worker accepted a new run. `exists`: the worker already has this thread id
 * (reconnect, not re-send); `runStatus` is its current status and `active` says whether it is executing.
 */
export type DispatchResult =
  | { status: "started" }
  | { status: "exists"; runStatus: string; active: boolean };

/** Event streamed from a worker. Shape is the engine's event envelope; kept loose here. */
export interface WorkerEvent {
  type: string;
  /** Per-thread sequence number (the SSE id). Unsequenced events carry -1. */
  seq?: number;
  data?: unknown;
  [key: string]: unknown;
}

export interface AttachOptions {
  /** Replay events with a seq greater than this. Default -1: everything from the start (seq 0 is a real event). */
  afterSeq?: number;
  /** Aborting stops the stream; the remote run keeps going. `result` then rejects with an AbortError. */
  signal?: AbortSignal;
}

/** How a child run ended (or stopped to wait). */
export interface WorkerOutcome {
  status: "completed" | "interrupted" | "error" | "cancelled";
  /** Final state channels (reserved channels stripped). Best effort for non-completed runs. */
  state?: Record<string, unknown>;
  error?: { code?: string; message: string };
  /** For `interrupted`: the pending interrupts as the worker reported them. */
  interrupts?: unknown[];
  /** Highest event seq seen; pass as `afterSeq` when re-attaching after a resume. */
  lastSeq?: number;
}

/**
 * `events` ends at the terminal event (run end, error, abort, or the run-level interrupt) and is
 * buffered, so iterating is optional; `result` settles either way.
 */
export interface WorkerRunAttachment {
  events: AsyncIterable<WorkerEvent>;
  result: Promise<WorkerOutcome>;
}

/** Options for an artifact transfer. Aborting rejects it with an `AbortError`. */
export interface ArtifactTransferOptions {
  signal?: AbortSignal;
}

/** An artifact on a worker: the file of an `Artifact` record (by `sha256`) in a child run's final state. */
export interface ArtifactSource {
  /** The child run's thread id. */
  threadId: string;
  sha256: string;
}

/** What `getArtifact` wrote: measured while streaming, so the caller can verify it. */
export interface ArtifactDownload {
  sha256: string;
  sizeBytes: number;
}

export interface WorkerTransport {
  labels(target: TransportTarget): Promise<WorkerLabels>;
  preflight(target: TransportTarget, req: PreflightRequest): Promise<PreflightResult>;
  dispatch(target: TransportTarget, req: DispatchRequest): Promise<DispatchResult>;
  attach(target: TransportTarget, childThreadId: string, opts?: AttachOptions): WorkerRunAttachment;
  resume(target: TransportTarget, childThreadId: string, resume: unknown): Promise<void>;
  cancel(target: TransportTarget, childThreadId: string): Promise<void>;
  /** Whether the worker's content store holds `sha256` (`HEAD /worker/artifacts/:sha256`). */
  hasArtifact(target: TransportTarget, sha256: string, opts?: ArtifactTransferOptions): Promise<boolean>;
  /** Streams `file` into the worker's content store under `sha256`; the worker verifies the hash. No full buffering. */
  putArtifact(target: TransportTarget, sha256: string, file: string, opts?: ArtifactTransferOptions): Promise<void>;
  /**
   * Streams an artifact of a child run to `destFile` (created, overwritten) and returns the sha-256 and
   * size of what was written, measured while streaming. It does not compare them with `source.sha256`;
   * the caller does. On failure `destFile` may be left partial.
   */
  getArtifact(target: TransportTarget, source: ArtifactSource, destFile: string, opts?: ArtifactTransferOptions): Promise<ArtifactDownload>;
}

/** One scripted child run for the fake transport. */
export interface FakeRun {
  /** Events `attach().events` yields before it ends. */
  events?: WorkerEvent[];
  /** How the run ends. Default: completed with empty state. An Error rejects `result` (transport failure). */
  outcome?: WorkerOutcome | Error;
  /** Never settle on its own: ends `cancelled` when `cancel` is called, or rejects when the attach signal aborts. */
  hang?: boolean;
}

/** A value, or a list consumed one per call (the last entry repeats). */
export type FakeScript<T> = T | T[];

export interface FakeTransportFixture {
  /** Labels the target reports; an Error makes `labels()` reject (unreachable). */
  labels: WorkerLabels | Error;
  /** Preflight outcome; default ok. A function can inspect the request. */
  preflight?: PreflightResult | ((req: PreflightRequest) => PreflightResult);
  /** Dispatch outcome; default `{ status: "started" }`. An Error rejects. */
  dispatch?: FakeScript<DispatchResult | Error>;
  /** Run an `attach` observes; default completed with empty state. An Error makes `attach` throw. */
  attach?: FakeScript<FakeRun | Error | ((childThreadId: string, dispatched: DispatchRequest | undefined) => FakeRun | Promise<FakeRun>)>;
  /** An Error makes `cancel` reject. */
  cancel?: Error;
  /** Artifact store of the target. */
  artifacts?: FakeArtifacts;
}

/**
 * Scripted artifacts for a fake target. `has` is the content store `hasArtifact` answers from;
 * `putArtifact` adds to it. `blobs` are what `getArtifact` serves, by sha-256 (a string is UTF-8):
 * content that does not hash to its key makes the download a mismatch. An Error rejects the transfer.
 */
export interface FakeArtifacts {
  has?: string[];
  blobs?: Record<string, Uint8Array | string | Error>;
  /** Error that makes `hasArtifact` / `putArtifact` reject. */
  hasError?: Error;
  putError?: Error;
}

export interface FakeTransportCalls {
  preflightCalls: Array<{ target: string; req: PreflightRequest }>;
  dispatchCalls: Array<{ target: string; req: DispatchRequest }>;
  attachCalls: Array<{ target: string; childThreadId: string; opts: AttachOptions | undefined }>;
  cancelCalls: Array<{ target: string; childThreadId: string }>;
  resumeCalls: Array<{ target: string; childThreadId: string; resume: unknown }>;
  hasCalls: Array<{ target: string; sha256: string }>;
  /** `bytes` is the file content when `putArtifact` was called. */
  putCalls: Array<{ target: string; sha256: string; file: string; bytes: Buffer }>;
  getCalls: Array<{ target: string; threadId: string; sha256: string; destFile: string }>;
}

function nextOf<T>(script: FakeScript<T> | undefined, index: number): T | undefined {
  if (script === undefined) return undefined;
  if (!Array.isArray(script)) return script;
  return script[Math.min(index, script.length - 1)];
}

/**
 * Test helper: `labels`, `preflight`, `dispatch`, `attach`, `cancel` and `resume` from fixtures keyed by
 * target name, recording every call. Artifact methods answer from `FakeTransportFixture.artifacts`.
 */
export function createFakeTransport(fixtures: Record<string, FakeTransportFixture>): WorkerTransport & FakeTransportCalls {
  const fx = (t: TransportTarget): FakeTransportFixture => {
    const f = fixtures[t.name];
    if (!f) throw new Error(`no fixture for target "${t.name}"`);
    return f;
  };
  const calls: FakeTransportCalls = { preflightCalls: [], dispatchCalls: [], attachCalls: [], cancelCalls: [], resumeCalls: [], hasCalls: [], putCalls: [], getCalls: [] };
  const stored = new Map<string, Set<string>>();
  const storeOf = (t: TransportTarget): Set<string> => {
    let set = stored.get(t.name);
    if (!set) stored.set(t.name, (set = new Set(fx(t).artifacts?.has ?? [])));
    return set;
  };
  const dispatchCount = new Map<string, number>();
  const attachCount = new Map<string, number>();
  const hanging = new Map<string, () => void>();
  const dispatched = new Map<string, DispatchRequest>();
  return {
    ...calls,
    async labels(t) {
      const f = fx(t).labels;
      if (f instanceof Error) throw f;
      return f;
    },
    async preflight(t, req) {
      calls.preflightCalls.push({ target: t.name, req });
      const p = fx(t).preflight;
      return typeof p === "function" ? p(req) : (p ?? { ok: true, diagnostics: [] });
    },
    async dispatch(t, req) {
      calls.dispatchCalls.push({ target: t.name, req });
      dispatched.set(req.childThreadId, req);
      const n = dispatchCount.get(t.name) ?? 0;
      dispatchCount.set(t.name, n + 1);
      const r = nextOf(fx(t).dispatch, n) ?? { status: "started" as const };
      if (r instanceof Error) throw r;
      return r;
    },
    attach(t, childThreadId, opts) {
      calls.attachCalls.push({ target: t.name, childThreadId, opts });
      const n = attachCount.get(t.name) ?? 0;
      attachCount.set(t.name, n + 1);
      const scripted = nextOf(fx(t).attach, n) ?? {};
      if (scripted instanceof Error) throw scripted;
      // A function may run the dispatched child (a worker simulator); resolve it lazily.
      const runP: Promise<FakeRun> = Promise.resolve(typeof scripted === "function" ? scripted(childThreadId, dispatched.get(childThreadId)) : scripted);
      const result = runP.then(
        (run) =>
          new Promise<WorkerOutcome>((resolve, reject) => {
            if (run.hang) {
              hanging.set(`${t.name}|${childThreadId}`, () => resolve({ status: "cancelled" }));
              const abort = () => reject(Object.assign(new Error("attach aborted"), { name: "AbortError" }));
              if (opts?.signal?.aborted) abort();
              else opts?.signal?.addEventListener("abort", abort, { once: true });
              return;
            }
            const o = run.outcome ?? { status: "completed" as const, state: {} };
            if (o instanceof Error) reject(o);
            else resolve(o);
          }),
      );
      result.catch(() => undefined);
      return {
        events: (async function* () {
          const run = await runP;
          for (const e of run.events ?? []) yield e;
        })(),
        result,
      };
    },
    async cancel(t, childThreadId) {
      calls.cancelCalls.push({ target: t.name, childThreadId });
      const err = fx(t).cancel;
      if (err) throw err;
      hanging.get(`${t.name}|${childThreadId}`)?.();
    },
    async resume(t, childThreadId, resume) {
      calls.resumeCalls.push({ target: t.name, childThreadId, resume });
    },
    async hasArtifact(t, sha256) {
      calls.hasCalls.push({ target: t.name, sha256 });
      const err = fx(t).artifacts?.hasError;
      if (err) throw err;
      return storeOf(t).has(sha256);
    },
    async putArtifact(t, sha256, file) {
      const bytes = await readFile(file);
      calls.putCalls.push({ target: t.name, sha256, file, bytes });
      const err = fx(t).artifacts?.putError;
      if (err) throw err;
      storeOf(t).add(sha256);
    },
    async getArtifact(t, source, destFile) {
      calls.getCalls.push({ target: t.name, threadId: source.threadId, sha256: source.sha256, destFile });
      const blob = fx(t).artifacts?.blobs?.[source.sha256];
      if (blob === undefined) throw new Error(`FakeTransport: target "${t.name}" has no artifact ${source.sha256} for "${source.threadId}"`);
      if (blob instanceof Error) throw blob;
      const bytes = typeof blob === "string" ? Buffer.from(blob) : Buffer.from(blob);
      await writeFile(destFile, bytes);
      return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength };
    },
  };
}
