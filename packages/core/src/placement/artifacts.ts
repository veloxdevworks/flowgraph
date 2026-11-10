/**
 * Artifact records and staged references for node placement (ADR-0020 §10).
 *
 * An `Artifact` record (ADR-0017) names a file under the workspace. When a placed node crosses to a
 * worker, each record in its input is uploaded by `sha256` and replaced by a **staged reference**:
 *
 *     { ...record, path: "fg-staged:<sha256>/<basename>", staged: true, sha256 }
 *
 * The worker copies the blob into its own workspace when the run starts and rewrites `path` to a
 * normal workspace-relative path (dropping `staged`), so nodes there read an ordinary record.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Prefix of a staged reference's `path`. Not a real path on either machine, so a worker that does not understand it fails loudly. */
export const STAGED_PREFIX = "fg-staged:";

/** The loose `Artifact` shape (ADR-0017) that staging reads and rewrites. */
export interface ArtifactLike {
  kind: "artifact";
  path: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  staged?: boolean;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

/** An `Artifact` record, strictly: `kind`, a non-empty `path` and `mimeType`, an integer `sizeBytes`, and `sha256` if present a string. */
export function isArtifactRecord(value: unknown): value is ArtifactLike {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return (
    o["kind"] === "artifact" &&
    typeof o["path"] === "string" &&
    o["path"].length > 0 &&
    typeof o["mimeType"] === "string" &&
    o["mimeType"].length > 0 &&
    typeof o["sizeBytes"] === "number" &&
    Number.isInteger(o["sizeBytes"]) &&
    o["sizeBytes"] >= 0 &&
    (o["sha256"] === undefined || typeof o["sha256"] === "string")
  );
}

/** A file name that is one safe path segment: no separators, no leading dot, bounded length, extension kept. */
export function safeBasename(name: string): string {
  const base = name.split(/[\\/]/).filter(Boolean).pop() ?? "";
  let cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_");
  if (cleaned.length > 120) {
    const dot = cleaned.lastIndexOf(".");
    const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
    cleaned = cleaned.slice(0, 120 - ext.length) + ext;
  }
  return cleaned || "artifact";
}

export function stagedPath(sha256: string, basename: string): string {
  return `${STAGED_PREFIX}${sha256}/${safeBasename(basename)}`;
}

/** Parse `fg-staged:<sha256>/<basename>`; undefined when it is not a well-formed reference. */
export function parseStagedPath(p: string): { sha256: string; basename: string } | undefined {
  if (!p.startsWith(STAGED_PREFIX)) return undefined;
  const rest = p.slice(STAGED_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return undefined;
  const sha256 = rest.slice(0, slash);
  const basename = rest.slice(slash + 1);
  if (!isSha256(sha256) || !basename || safeBasename(basename) !== basename) return undefined;
  return { sha256, basename };
}

/** True for a record the coordinator marked as staged (it may still be malformed: see `parseStagedPath`). */
export function isStagedRecord(value: unknown): value is ArtifactLike {
  return isArtifactRecord(value) && value.staged === true && value.path.startsWith(STAGED_PREFIX);
}

/** SHA-256 of a file, hex, read as a stream. */
export async function sha256OfFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, signal ? { signal } : {})) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Plain data (object literals, JSON): what the walkers descend into. */
const isPlain = (v: unknown): v is Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * Every `Artifact` record reachable in `value` (plain objects and arrays), in document order. A record's
 * own fields are not searched. A media node's output holds the same record in `artifact` and `artifacts`; it is listed twice.
 */
export function findArtifacts(value: unknown): ArtifactLike[] {
  const out: ArtifactLike[] = [];
  const seen = new WeakSet<object>();
  const walk = (v: unknown): void => {
    if (v == null || typeof v !== "object") return;
    if (isArtifactRecord(v)) {
      out.push(v);
      return;
    }
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (isPlain(v)) {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(value);
  return out;
}

export interface ArtifactRewrite {
  /** The record that replaces the original. */
  record: ArtifactLike;
  /**
   * What a legacy absolute `path` (a `demo` output's `path` / `extra[].path`) naming the original file becomes.
   * Omit to leave such paths alone.
   */
  legacyPath?: string;
}

const toPosix = (p: string) => p.split("\\").join("/");

/** True when the absolute legacy path `abs` names the file of the workspace-relative record path `rel`. */
function legacyNames(abs: string, rel: string): boolean {
  const a = toPosix(abs);
  const r = toPosix(rel).replace(/^(\.\/)+/, "");
  return a === r || a.endsWith(`/${r}`);
}

/**
 * A copy of `value` with every `Artifact` record replaced by `rewrite(record)`. Inputs are not mutated.
 * In an object that also lists records under `artifacts` (a `demo` output), a legacy absolute `path`
 * and `extra[].path` naming a rewritten record's file are replaced by the rewrite's `legacyPath`.
 */
export async function mapArtifacts(value: unknown, rewrite: (record: ArtifactLike) => Promise<ArtifactRewrite>): Promise<unknown> {
  const seen = new WeakSet<object>();
  const walk = async (v: unknown): Promise<unknown> => {
    if (v == null || typeof v !== "object") return v;
    if (isArtifactRecord(v)) return (await rewrite(v)).record;
    if (seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) out.push(await walk(x));
      return out;
    }
    if (!isPlain(v)) return v;
    const out: Record<string, unknown> = {};
    const legacy: Array<{ from: string; to: string }> = [];
    for (const [k, x] of Object.entries(v)) {
      if (k === "artifacts" && Array.isArray(x)) {
        const list: unknown[] = [];
        for (const item of x) {
          if (isArtifactRecord(item)) {
            const r = await rewrite(item);
            list.push(r.record);
            if (r.legacyPath !== undefined) legacy.push({ from: item.path, to: r.legacyPath });
          } else {
            list.push(await walk(item));
          }
        }
        out[k] = list;
      } else {
        out[k] = await walk(x);
      }
    }
    if (legacy.length > 0) {
      const fix = (s: unknown): unknown => {
        if (typeof s !== "string") return s;
        const hit = legacy.find((l) => legacyNames(s, l.from));
        return hit ? hit.to : s;
      };
      if (typeof out["path"] === "string") out["path"] = fix(out["path"]);
      if (Array.isArray(out["extra"])) {
        out["extra"] = (out["extra"] as unknown[]).map((e) => (isPlain(e) && typeof e["path"] === "string" ? { ...e, path: fix(e["path"]) } : e));
      }
    }
    return out;
  };
  return walk(value);
}

/** A record without the fields that name another machine's files. */
export function withoutThumbnail(record: ArtifactLike): ArtifactLike {
  if (!record.meta || !("thumbnail" in record.meta)) return record;
  const { thumbnail: _drop, ...meta } = record.meta;
  void _drop;
  return { ...record, meta };
}
