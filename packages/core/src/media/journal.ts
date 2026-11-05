/**
 * Write-ahead journal for media jobs.
 *
 * `ctx.once` only persists when a node returns, so a crash halfway through a
 * multi-minute job would resubmit (and pay for) it on resume. The journal is
 * written the moment a vendor accepts a job and read before every submit, so
 * resume, retry and replay all re-attach to the job already in flight.
 *
 * Remaining window: a crash between the vendor accepting the job and the
 * journal write completing (milliseconds). Vendors that support idempotency
 * keys should use `JobHandle`-independent keys derived from the fingerprint.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Artifact } from "@flowgraph/spec";
import { safeSegment } from "./artifacts.js";
import type { JobHandle, MediaRequest } from "./types.js";

export interface JournalEntry {
  version: 1;
  state: "submitted" | "done";
  provider: string;
  submittedAt: string;
  handle: JobHandle;
  /** Present when state is "done". */
  artifacts?: Artifact[];
  costUSD?: number;
}

export interface Journal {
  read(): Promise<JournalEntry | undefined>;
  write(entry: JournalEntry): Promise<void>;
  remove(): Promise<void>;
}

/** Stable identity of a request: same request, same job. */
export function fingerprintRequest(provider: string, req: MediaRequest, jobIndex: number): string {
  const canonical = JSON.stringify({
    provider,
    jobIndex,
    modality: req.modality,
    model: req.model ?? null,
    prompt: req.prompt ?? null,
    negativePrompt: req.negativePrompt ?? null,
    inputs: req.inputs.map((i) => i.identity),
    count: req.count,
    size: req.size ?? null,
    aspectRatio: req.aspectRatio ?? null,
    quality: req.quality ?? null,
    seed: req.seed ?? null,
    duration: req.duration ?? null,
    resolution: req.resolution ?? null,
    mode: req.mode ?? null,
    format: req.format ?? null,
    texture: req.texture ?? null,
    params: sortKeys(req.params),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export function createFileJournal(opts: {
  workspace: string;
  scope: string;
  nodeId: string;
  fingerprint: string;
}): Journal {
  const dir = path.join(opts.workspace, ".flowgraph", "jobs", safeSegment(opts.scope));
  const file = path.join(dir, `${safeSegment(opts.nodeId)}-${opts.fingerprint}.json`);

  return {
    async read() {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as JournalEntry;
        return parsed?.version === 1 ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    async write(entry) {
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(entry), "utf8");
      await rename(tmp, file);
    },
    async remove() {
      await rm(file, { force: true });
    },
  };
}
