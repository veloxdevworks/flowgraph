/**
 * The worker side of artifact staging (ADR-0020 §10).
 *
 * Blobs a coordinator uploads live in a content store under the workspace, addressed by sha-256:
 * `<workspace>/.flowgraph/artifact-store/<sha256>` (multi-user servers add one directory per
 * principal, so callers cannot probe or reference each other's blobs). When a run starts, staged
 * references in its input are copied from the store into the run's own artifact directory.
 */

import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { artifactDir, isSha256, mapArtifacts, parseStagedPath, isStagedRecord, withoutThumbnail, type ArtifactLike, type ArtifactRewrite } from "@flowgraph/core";
import { ServerRequestError } from "./errors.js";

/** Default `FLOWGRAPH_ARTIFACT_MAX_BYTES`: 4 GiB. `0` disables the limit. */
export const DEFAULT_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024 * 1024;

export function artifactStoreDir(workspace: string, scope = ""): string {
  const root = path.join(workspace, ".flowgraph", "artifact-store");
  return scope ? path.join(root, scope) : root;
}

/** Directory scope for a principal on a multi-user server (a hash: ids are arbitrary strings). */
export function storeScopeOf(principalId: string): string {
  return `p-${createHash("sha256").update(principalId).digest("hex").slice(0, 24)}`;
}

export function assertSha256(value: string): string {
  if (!isSha256(value)) throw new ServerRequestError(400, "ARTIFACT_SHA_INVALID", "sha256 must be 64 lowercase hex characters");
  return value;
}

export async function hasBlob(workspace: string, scope: string, sha256: string): Promise<boolean> {
  const st = await stat(path.join(artifactStoreDir(workspace, scope), sha256)).catch(() => undefined);
  return Boolean(st?.isFile());
}

export class ArtifactTooLargeError extends ServerRequestError {
  constructor(readonly maxBytes: number) {
    super(413, "ARTIFACT_TOO_LARGE", `Artifact exceeds the limit of ${maxBytes} bytes (FLOWGRAPH_ARTIFACT_MAX_BYTES)`);
  }
}

/**
 * Stream `body` into the store as `sha256`: to a temp file, hash-verified, then renamed into place.
 * Throws 413 `ARTIFACT_TOO_LARGE` past `maxBytes` and 400 `ARTIFACT_HASH_MISMATCH` when the bytes do not hash to `sha256`.
 */
export async function putBlob(
  workspace: string,
  scope: string,
  sha256: string,
  body: Readable,
  maxBytes: number,
): Promise<{ sizeBytes: number; existed: boolean }> {
  const dir = artifactStoreDir(workspace, scope);
  await mkdir(dir, { recursive: true });
  const final = path.join(dir, sha256);
  const tmp = path.join(dir, `.${sha256}.${randomBytes(6).toString("hex")}.partial`);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    // Not `pipeline`: on an error it would destroy the request and its socket, and the caller
    // could no longer be told why (413, 400).
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(tmp);
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        body.off("data", onData);
        body.off("end", onEnd);
        body.off("error", finish);
        body.off("close", onClose);
        if (err) {
          body.pause();
          out.destroy();
          reject(err);
        } else resolve();
      };
      const onData = (chunk: Buffer | string) => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        sizeBytes += buf.length;
        if (maxBytes > 0 && sizeBytes > maxBytes) return finish(new ArtifactTooLargeError(maxBytes));
        hash.update(buf);
        if (!out.write(buf)) {
          body.pause();
          out.once("drain", () => body.resume());
        }
      };
      const onEnd = () => out.end(() => finish());
      const onClose = () => {
        if (!body.readableEnded) finish(new Error("Upload ended before the whole body arrived"));
      };
      out.on("error", finish);
      body.on("data", onData);
      body.once("end", onEnd);
      body.once("error", finish);
      body.once("close", onClose);
    });
    const got = hash.digest("hex");
    if (got !== sha256) {
      throw new ServerRequestError(400, "ARTIFACT_HASH_MISMATCH", `The body hashes to ${got}, not ${sha256}`);
    }
    const existed = Boolean(await stat(final).catch(() => undefined));
    // Same content either way; rename replaces atomically.
    await rename(tmp, final);
    return { sizeBytes, existed };
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * Replace the staged references in a run's input by records for copies in the run's own artifact
 * directory of `workspace` (`.flowgraph/artifacts/<thread>/staged/<sha256>/<basename>`, workspace-relative).
 * `storeRoot` is where the content store lives (the graph store directory).
 * 422 `ARTIFACT_NOT_STAGED` when the store lacks a blob or a reference is malformed.
 */
export async function materializeStaged(
  storeRoot: string,
  scope: string,
  workspace: string,
  childThreadId: string,
  input: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (!input) return input;
  const copies = new Map<string, string>(); // sha256/basename -> workspace-relative path
  const out = await mapArtifacts(input, async (rec: ArtifactLike): Promise<ArtifactRewrite> => {
    if (!isStagedRecord(rec)) return { record: rec };
    const ref = parseStagedPath(rec.path);
    if (!ref) {
      throw new ServerRequestError(422, "ARTIFACT_NOT_STAGED", `Malformed staged artifact reference "${rec.path}"`);
    }
    if (rec.sha256 !== undefined && rec.sha256 !== ref.sha256) {
      throw new ServerRequestError(422, "ARTIFACT_NOT_STAGED", `Staged artifact "${rec.path}" declares sha256 ${rec.sha256}`);
    }
    const key = `${ref.sha256}/${ref.basename}`;
    let rel = copies.get(key);
    if (!rel) {
      const src = path.join(artifactStoreDir(storeRoot, scope), ref.sha256);
      if (!(await stat(src).then((s) => s.isFile(), () => false))) {
        throw new ServerRequestError(422, "ARTIFACT_NOT_STAGED", `Artifact ${ref.sha256} ("${ref.basename}") was not staged on this worker; PUT /worker/artifacts/${ref.sha256} first`);
      }
      const dir = path.join(artifactDir(workspace, childThreadId, "staged"), ref.sha256);
      const dest = path.join(dir, ref.basename);
      await mkdir(dir, { recursive: true });
      if (!(await stat(dest).then((s) => s.isFile(), () => false))) {
        // A copy, never a hardlink: a node that writes to its input would corrupt the store.
        const tmp = path.join(dir, `.${ref.basename}.${randomBytes(6).toString("hex")}.partial`);
        try {
          await copyFile(src, tmp, fsConstants.COPYFILE_FICLONE);
          await rename(tmp, dest);
        } finally {
          await rm(tmp, { force: true }).catch(() => undefined);
        }
      }
      rel = path.relative(workspace, dest).split(path.sep).join("/");
      copies.set(key, rel);
    }
    const { staged: _s, ...rest } = withoutThumbnail(rec);
    void _s;
    return { record: { ...rest, path: rel, sha256: ref.sha256 }, legacyPath: path.resolve(workspace, rel) };
  });
  return out as Record<string, unknown>;
}

/**
 * The real path of `relPath` inside `workspace`, or undefined when it does not name a regular file
 * there (missing, a directory, `..`, absolute elsewhere, or a symlink that leaves the workspace).
 */
export async function resolveInWorkspace(workspace: string, relPath: string): Promise<{ file: string; sizeBytes: number } | undefined> {
  try {
    const root = await realpath(workspace);
    const real = await realpath(path.resolve(root, relPath));
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    const st = await stat(real);
    return st.isFile() ? { file: real, sizeBytes: st.size } : undefined;
  } catch {
    return undefined;
  }
}
