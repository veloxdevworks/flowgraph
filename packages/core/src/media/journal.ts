/**
 * Write-ahead journal for media jobs.
 *
 * Submission intent is persisted before entering a vendor call. A missing response
 * leaves an explicit uncertain intent; retry requires reconciliation rather than
 * automatically submitting again. Accepted handles and completed results replace
 * the intent. The vendor may use the submission identity for idempotency only
 * when its API documents that guarantee.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import type { Artifact } from "@flowgraph/spec";
import { safeSegment } from "./artifacts.js";
import type { JobHandle, MediaRequest } from "./types.js";

export interface JournalEntry {
  version: 1;
  state: "intent" | "submitted" | "done";
  submissionId?: string;
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
  reserve?(entry: JournalEntry): Promise<boolean>;
}

/**
 * Stable identity of a request: same request, same job.
 *
 * `variant` is a cache-buster that is part of the identity but deliberately not
 * part of `MediaRequest` (vendors never see it). It joins the canonical JSON
 * only when it has a value, so a request without one hashes exactly as it did
 * before `variant` existed and in-flight journal entries still match.
 */
export function fingerprintRequest(
  provider: string,
  req: MediaRequest,
  jobIndex: number,
  variant?: string | number | null,
): string {
  const hasVariant = variant != null && variant !== "";
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
    audioKind: req.audioKind ?? null,
    text: req.text ?? null,
    voice: req.voice ?? null,
    language: req.language ?? null,
    instrumental: req.instrumental ?? null,
    format: req.format ?? null,
    texture: req.texture ?? null,
    params: sortKeys(req.params),
    ...(hasVariant ? { variant: String(variant) } : {}),
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
  const file = path.join(dir, `${safeSegment(opts.nodeId)}-${safeSegment(opts.fingerprint)}.json`);

  return {
    async read() {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as JournalEntry;
        if (parsed?.version !== 1 || !["intent", "submitted", "done"].includes(parsed.state) || !parsed.provider || !parsed.handle?.id || (parsed.state === "intent" && !parsed.submissionId)) throw new Error("Invalid media journal record");
        return parsed;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw Object.assign(new Error(`Media journal ${file} cannot be read; inspect/reconcile it before retrying`), { code: "MEDIA_JOURNAL_INVALID", retryable: false, cause });
      }
    },
    async write(entry) {
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      const fd = await open(tmp, "wx", 0o600);
      try { await fd.writeFile(JSON.stringify(entry), "utf8"); await fd.sync(); }
      finally { await fd.close(); }
      await rename(tmp, file);
    },
    async remove() {
      await rm(file, { force: true });
    },
    async reserve(entry) {
      await mkdir(dir, { recursive: true });
      let fd;
      try { fd = await open(file, "wx", 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
      try { await fd.writeFile(JSON.stringify(entry), "utf8"); await fd.sync(); }
      finally { await fd.close(); }
      return true;
    },
  };
}

/** Caller must hold thread admission and stop/reconcile any external work first. */
export async function resolveMediaSubmission(journal: Journal, submissionId: string, resolution: { notSubmitted: true } | { handle: JobHandle }): Promise<void> {
  const current = await journal.read();
  if (current?.state !== "intent" || current.submissionId !== submissionId) throw new Error("Submission identity changed or is no longer unresolved; inspect the journal again");
  if ("notSubmitted" in resolution) { await journal.remove(); return; }
  const handle = resolution.handle;
  if (!handle || typeof handle.id !== "string" || !handle.id || (handle.done !== undefined && !Array.isArray(handle.done))) throw new Error("Provide a vendor handle with an id and optional completed artifacts");
  await journal.write({ ...current, state: handle.done ? "done" : "submitted", handle, ...(handle.done ? { artifacts: handle.done } : {}), ...(handle.costUSD === undefined ? {} : { costUSD: handle.costUSD }) });
}
