/**
 * Artifact staging for a placed node (ADR-0020 §10), on the coordinator.
 *
 * - `stageIn` uploads the files of the `Artifact` records in a child's input (only blobs the worker
 *   lacks) and returns the input with each record replaced by a staged reference (see `artifacts.ts`).
 * - `stageOut` downloads the files of the `Artifact` records in what flows back, verifying their
 *   sha-256, into `.flowgraph/artifacts/<parentThread>/<nodeId>/` and rewrites the records.
 *
 * State holds records, never bytes; paths stay workspace-relative.
 */

import { randomBytes } from "node:crypto";
import { mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { artifactDir } from "../media/artifacts.js";
import {
  findArtifacts,
  isSha256,
  mapArtifacts,
  safeBasename,
  sha256OfFile,
  stagedPath,
  withoutThumbnail,
  type ArtifactLike,
  type ArtifactRewrite,
} from "./artifacts.js";
import type { TransportTarget, WorkerTransport } from "./transport.js";

export type StagingErrorCode = "ARTIFACT_MISSING" | "ARTIFACT_STAGE_IN_FAILED" | "ARTIFACT_STAGE_OUT_FAILED";

export class StagingError extends Error {
  constructor(
    readonly code: StagingErrorCode,
    message: string,
    opts: { cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "StagingError";
  }
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const toPosix = (p: string) => p.split(path.sep).join("/");
const isInside = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** What stage-in learned: staged-in files by sha, so a record that comes back unchanged keeps its coordinator path. */
export type StagedIn = Map<string, string>;

export interface StageInArgs {
  transport: WorkerTransport;
  target: TransportTarget;
  /** Coordinator workspace (absolute). */
  workspace: string;
  value: unknown;
  signal?: AbortSignal | undefined;
}

export interface StageInResult {
  value: unknown;
  /** sha-256 -> workspace-relative path of the coordinator's copy. */
  staged: StagedIn;
  /** Blobs sent (the worker lacked them). */
  uploaded: number;
}

interface Resolved {
  abs: string;
  sha256: string;
}

/**
 * Resolve a record's file in the coordinator workspace. A record is graph data, so a path that leaves
 * the workspace (absolute elsewhere, `..`, or a symlink out) is refused rather than uploaded.
 */
async function resolveLocal(workspace: string, workspaceReal: string, record: ArtifactLike): Promise<string> {
  const abs = path.resolve(workspace, record.path);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw new StagingError("ARTIFACT_MISSING", `artifact file "${record.path}" does not exist in workspace ${workspace}`);
  }
  if (!isInside(workspaceReal, real)) {
    throw new StagingError("ARTIFACT_MISSING", `artifact path "${record.path}" is outside the workspace ${workspace}, so it is not staged`);
  }
  const st = await stat(real);
  if (!st.isFile()) throw new StagingError("ARTIFACT_MISSING", `artifact path "${record.path}" in workspace ${workspace} is not a file`);
  return real;
}

export async function stageIn(args: StageInArgs): Promise<StageInResult> {
  const { transport, target, workspace, signal } = args;
  const staged: StagedIn = new Map();
  const records = findArtifacts(args.value);
  if (records.length === 0) return { value: args.value, staged, uploaded: 0 };

  const workspaceReal = await realpath(workspace).catch(() => path.resolve(workspace));
  // Resolve and hash everything before sending anything, so a missing file fails before the first upload.
  const resolved = new Map<string, Resolved>();
  for (const rec of records) {
    if (resolved.has(rec.path)) continue;
    const abs = await resolveLocal(workspace, workspaceReal, rec);
    let sha256 = rec.sha256;
    if (sha256 !== undefined && !isSha256(sha256)) {
      throw new StagingError("ARTIFACT_STAGE_IN_FAILED", `artifact "${rec.path}" has a malformed sha256 "${sha256}"`);
    }
    sha256 ??= await sha256OfFile(abs, signal);
    resolved.set(rec.path, { abs, sha256 });
  }

  let uploaded = 0;
  const sent = new Set<string>();
  for (const [rel, { abs, sha256 }] of resolved) {
    if (sent.has(sha256)) continue;
    try {
      if (!(await transport.hasArtifact(target, sha256, signal ? { signal } : {}))) {
        await transport.putArtifact(target, sha256, abs, signal ? { signal } : {});
        uploaded++;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new StagingError("ARTIFACT_STAGE_IN_FAILED", `artifact "${rel}" (sha256 ${sha256}) could not be sent to target "${target.name}": ${msg(err)}`, { cause: err });
    }
    sent.add(sha256);
    if (!staged.has(sha256)) staged.set(sha256, rel);
  }

  const value = await mapArtifacts(args.value, async (rec): Promise<ArtifactRewrite> => {
    const { sha256 } = resolved.get(rec.path)!;
    const ref = stagedPath(sha256, rec.path);
    return { record: { ...withoutThumbnail(rec), path: ref, sha256, staged: true }, legacyPath: ref };
  });
  return { value, staged, uploaded };
}

export interface StageOutArgs {
  transport: WorkerTransport;
  target: TransportTarget;
  /** The child run's thread id (where the files are). */
  childThreadId: string;
  /** Coordinator workspace (absolute). */
  workspace: string;
  /** The parent run's thread id and the placed node: the files land in `.flowgraph/artifacts/<parent>/<node>/`. */
  parentThreadId: string;
  nodeId: string;
  /** The value that flows back into the parent. */
  value: unknown;
  /** From stage-in: a record that comes back with one of these hashes keeps its coordinator path. */
  staged?: StagedIn | undefined;
  signal?: AbortSignal | undefined;
}

export interface StageOutResult {
  value: unknown;
  downloaded: number;
}

/** First free name in `dir` for `base`, or the existing file of that name when it already holds `sha256`. */
async function targetFor(dir: string, base: string, sha256: string, signal?: AbortSignal): Promise<{ file: string; present: boolean }> {
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 0; ; i++) {
    const file = path.join(dir, i === 0 ? base : `${stem}-${i}${ext}`);
    const st = await stat(file).catch(() => undefined);
    if (!st) return { file, present: false };
    if (st.isFile() && (await sha256OfFile(file, signal)) === sha256) return { file, present: true };
  }
}

export async function stageOut(args: StageOutArgs): Promise<StageOutResult> {
  const { transport, target, workspace, signal } = args;
  if (findArtifacts(args.value).length === 0) return { value: args.value, downloaded: 0 };

  const dir = artifactDir(workspace, args.parentThreadId, args.nodeId);
  const done = new Map<string, string>(); // sha256 -> workspace-relative path
  let downloaded = 0;

  const fetchOne = async (rec: ArtifactLike): Promise<string> => {
    const sha256 = rec.sha256;
    if (sha256 === undefined || !isSha256(sha256)) {
      throw new Error(`the record has no valid sha256, so the worker cannot be asked for it`);
    }
    const known = done.get(sha256);
    if (known) return known;
    const kept = args.staged?.get(sha256);
    if (kept && (await stat(path.resolve(workspace, kept)).then((s) => s.isFile(), () => false))) {
      done.set(sha256, kept);
      return kept;
    }
    await mkdir(dir, { recursive: true });
    const { file, present } = await targetFor(dir, safeBasename(rec.path), sha256, signal);
    if (!present) {
      const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("hex")}.partial`);
      try {
        const got = await transport.getArtifact(target, { threadId: args.childThreadId, sha256 }, tmp, signal ? { signal } : {});
        if (got.sha256 !== sha256) {
          throw new Error(`sha256 mismatch: expected ${sha256}, received ${got.sha256} (${got.sizeBytes} bytes)`);
        }
        await rename(tmp, file);
        downloaded++;
      } finally {
        await rm(tmp, { force: true }).catch(() => undefined);
      }
    }
    const rel = toPosix(path.relative(workspace, file));
    done.set(sha256, rel);
    return rel;
  };

  const value = await mapArtifacts(args.value, async (rec): Promise<ArtifactRewrite> => {
    let rel: string;
    try {
      rel = await fetchOne(rec);
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new StagingError(
        "ARTIFACT_STAGE_OUT_FAILED",
        `artifact "${rec.path}" (sha256 ${rec.sha256 ?? "unknown"}) could not be fetched from target "${target.name}" (child run "${args.childThreadId}"): ${msg(err)}`,
        { cause: err },
      );
    }
    const { staged: _s, ...rest } = withoutThumbnail(rec);
    void _s;
    return { record: { ...rest, path: rel }, legacyPath: path.resolve(workspace, rel) };
  });
  return { value, downloaded };
}
