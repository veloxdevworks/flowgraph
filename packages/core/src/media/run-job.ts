/**
 * Run one media job to completion: re-attach via the journal, submit if
 * needed, poll with backoff, collect outputs. See ADR-0017.
 */

import type { Artifact } from "@flowgraph/spec";
import { parseDuration, sleep } from "../runtime/duration.js";
import { artifactsExist } from "./artifacts.js";
import type { Journal } from "./journal.js";
import type { JobHandle, JobStatus, MediaCallContext, MediaProvider, MediaRequest } from "./types.js";

export interface RunMediaJobOptions {
  provider: MediaProvider;
  req: MediaRequest;
  mctx: MediaCallContext;
  journal: Journal;
  workspace: string;
  /** Whole-job limit, e.g. "10m". */
  timeout: string;
  emit(phase: string, data: Record<string, unknown>): void;
}

export interface MediaJobResult {
  artifacts: Artifact[];
  /** Cost to charge this run's budget; 0 when the result came from the journal. */
  costUSD: number;
  /** True when finished outputs were reused instead of generating again. */
  reused: boolean;
}

const DEFAULT_POLL_START_MS = 2000;
const DEFAULT_POLL_MAX_MS = 10_000;

export async function runMediaJob(opts: RunMediaJobOptions): Promise<MediaJobResult> {
  const { provider, req, mctx, journal } = opts;
  const timeoutMs = parseDuration(opts.timeout);
  const deadline = Date.now() + timeoutMs;

  const existing = await journal.read();
  if (existing?.state === "done" && existing.artifacts && (await artifactsExist(opts.workspace, existing.artifacts))) {
    opts.emit("reused", { provider: provider.name, jobId: existing.handle.id });
    return { artifacts: existing.artifacts, costUSD: 0, reused: true };
  }

  let handle: JobHandle;
  let submittedAt = existing?.submittedAt ?? new Date().toISOString();
  if (existing?.state === "submitted") {
    handle = existing.handle;
    opts.emit("resumed", { provider: provider.name, jobId: handle.id });
  } else {
    handle = await provider.start(req, mctx);
    submittedAt = new Date().toISOString();
    await journal.write({
      version: 1,
      state: handle.done ? "done" : "submitted",
      provider: provider.name,
      submittedAt,
      handle,
      ...(handle.done ? { artifacts: handle.done } : {}),
    });
    opts.emit("submitted", { provider: provider.name, jobId: handle.id });
  }

  const estimate = provider.estimateCostUSD?.(req);

  if (handle.done) {
    return { artifacts: handle.done, costUSD: estimate ?? 0, reused: false };
  }
  if (!provider.poll || !provider.fetch) {
    throw new Error(`media provider "${provider.name}" returned a pending job but has no poll/fetch`);
  }

  let status: JobStatus = { state: "queued" };
  let delay = Math.min(provider.pollIntervalMs ?? DEFAULT_POLL_START_MS, DEFAULT_POLL_MAX_MS);
  const cap = Math.max(provider.pollIntervalMs ?? DEFAULT_POLL_MAX_MS, delay);
  let lastProgress = -1;

  try {
    for (;;) {
      mctx.signal?.throwIfAborted();
      status = await provider.poll(handle, mctx);
      if (status.handle) {
        handle = status.handle;
        await journal.write({ version: 1, state: "submitted", provider: provider.name, submittedAt, handle });
        opts.emit("stage", { provider: provider.name, jobId: handle.id });
      }
      if (status.progress !== undefined && status.progress !== lastProgress) {
        lastProgress = status.progress;
        opts.emit("progress", { provider: provider.name, jobId: handle.id, progress: status.progress });
      }
      if (status.state === "done") break;
      if (status.state === "failed" || status.state === "canceled") {
        await journal.remove();
        throw new Error(
          `${provider.name}: job ${handle.id} ${status.state}${status.error ? `: ${status.error}` : ""}`,
        );
      }
      if (Date.now() + delay > deadline) {
        // Journal stays: a retry re-attaches to the job, which may still finish.
        throw new Error(
          `${provider.name}: job ${handle.id} still ${status.state} after ${opts.timeout}; ` +
            `it was left running and a retry will re-attach to it`,
        );
      }
      await sleep(delay, mctx.signal);
      delay = Math.min(Math.round(delay * 1.5), cap);
    }
  } catch (err) {
    if (mctx.signal?.aborted) {
      await provider.cancel?.(handle, mctx).catch(() => undefined);
      await journal.remove().catch(() => undefined);
    }
    throw err;
  }

  const artifacts = await provider.fetch(handle, mctx);
  const costUSD = status.costUSD ?? estimate ?? 0;
  await journal.write({
    version: 1,
    state: "done",
    provider: provider.name,
    submittedAt,
    handle,
    artifacts,
    costUSD,
  });
  opts.emit("done", { provider: provider.name, jobId: handle.id, artifacts: artifacts.length, costUSD });
  return { artifacts, costUSD, reused: false };
}
