/**
 * Artifact store for generated media. Files live under
 * `<workspace>/.flowgraph/artifacts/<thread>/<node>/`; state holds only the
 * `Artifact` record.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Artifact } from "@flowgraph/spec";
import type { MediaCallContext, MediaOutput } from "./types.js";

/** Largest single download, in bytes. */
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/opus": "opus",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "model/gltf-binary": "glb",
  "model/gltf+json": "gltf",
  "model/obj": "obj",
  "model/stl": "stl",
  "model/3mf": "3mf",
  "model/vnd.usdz+zip": "usdz",
  "application/octet-stream": "bin",
};

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  opus: "audio/opus",
  m4a: "audio/mp4",
  aac: "audio/aac",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "model/obj",
  stl: "model/stl",
  "3mf": "model/3mf",
  usdz: "model/vnd.usdz+zip",
  fbx: "application/octet-stream",
};

export function extensionForMime(mimeType: string, urlHint?: string): string {
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  const known = MIME_EXT[base];
  if (known && known !== "bin") return known;
  const fromUrl = urlHint ? path.extname(urlHint.split("?")[0]!).slice(1).toLowerCase() : "";
  if (fromUrl && /^[a-z0-9]{1,5}$/.test(fromUrl)) return fromUrl;
  return known ?? "bin";
}

export function mimeForExtension(ext: string): string | undefined {
  return EXT_MIME[ext.replace(/^\./, "").toLowerCase()];
}

export function roleForMime(mimeType: string, ext: string): Artifact["role"] {
  const m = mimeType.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("model/") || ["glb", "gltf", "fbx", "obj", "usdz", "stl", "3mf"].includes(ext)) return "model3d";
  return "file";
}

/** One path segment, safe to use as a directory/file name. */
export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, 80);
  return cleaned || "_";
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Read width/height from a PNG or JPEG header; undefined for anything else. */
export function probeImageSize(buf: Uint8Array): { width: number; height: number } | undefined {
  const b = Buffer.from(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, 65536));
  // PNG: 8-byte signature, then IHDR with big-endian width/height at 16/20.
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  // JPEG: walk markers to the first SOFn frame header.
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return undefined;
}

export interface OutputWriterOptions {
  /** Absolute workspace root. */
  workspace: string;
  /** Thread (or run) id; scopes the directory so runs cannot collide. */
  scope: string;
  nodeId: string;
  /** Deterministic prefix for this job's files. */
  jobKey: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal | undefined;
  provenance?: NonNullable<Artifact["meta"]>["source"];
}

export function artifactDir(workspace: string, scope: string, nodeId: string): string {
  return path.join(workspace, ".flowgraph", "artifacts", safeSegment(scope), safeSegment(nodeId));
}

/** Build the `saveOutput` function handed to providers. */
export function createOutputWriter(opts: OutputWriterOptions): MediaCallContext["saveOutput"] {
  let counter = 0;
  const dir = artifactDir(opts.workspace, opts.scope, opts.nodeId);

  return async (out: MediaOutput): Promise<Artifact> => {
    await mkdir(dir, { recursive: true });
    const index = counter++;
    const stem = `${safeSegment(opts.jobKey)}-${index}`;

    let tmp = path.join(dir, `.${stem}.partial`);
    let sha256: string;
    let sizeBytes: number;
    let mimeType: string;
    let urlHint: string | undefined;
    let head: Uint8Array | undefined;

    try {
      if ("bytes" in out) {
        mimeType = out.mimeType;
        sha256 = createHash("sha256").update(out.bytes).digest("hex");
        sizeBytes = out.bytes.byteLength;
        head = out.bytes.subarray(0, 65536);
        await writeFile(tmp, out.bytes);
      } else {
        urlHint = out.url;
        const res = await opts.fetchImpl(out.url, {
          ...(out.headers ? { headers: out.headers } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        if (!res.ok || !res.body) {
          throw new Error(`download failed: HTTP ${res.status} for ${redactUrl(out.url)}`);
        }
        mimeType =
          out.mimeType ?? res.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
        const hash = createHash("sha256");
        let total = 0;
        const first: Buffer[] = [];
        let firstLen = 0;
        const counting = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            total += chunk.length;
            if (total > MAX_ARTIFACT_BYTES) {
              cb(new Error(`download exceeds ${MAX_ARTIFACT_BYTES} bytes`));
              return;
            }
            hash.update(chunk);
            if (firstLen < 65536) {
              first.push(chunk);
              firstLen += chunk.length;
            }
            cb(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
          counting,
          createWriteStream(tmp),
        );
        sha256 = hash.digest("hex");
        sizeBytes = total;
        head = Buffer.concat(first);
      }

      const explicit = out.ext?.replace(/^\./, "").toLowerCase();
      const ext = explicit && /^[a-z0-9]{1,5}$/.test(explicit) ? explicit : extensionForMime(mimeType, urlHint);
      const finalPath = path.join(dir, `${stem}.${ext}`);
      await rename(tmp, finalPath);
      tmp = "";

      const dims = head && mimeType.startsWith("image/") ? probeImageSize(head) : undefined;
      const rel = toPosix(path.relative(opts.workspace, finalPath));
      const meta: NonNullable<Artifact["meta"]> = {
        ...(dims ?? {}),
        ...(opts.provenance ? { source: opts.provenance } : {}),
        ...(out.meta ?? {}),
      };
      return {
        kind: "artifact",
        path: rel,
        mimeType,
        sizeBytes,
        role: roleForMime(mimeType, ext),
        sha256,
        ...(Object.keys(meta).length ? { meta } : {}),
      };
    } finally {
      if (tmp) await rm(tmp, { force: true }).catch(() => undefined);
    }
  };
}

/** Strip query strings (signed URLs carry credentials) before logging a URL. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<url>";
  }
}

/** True when every artifact's file is still on disk. */
export async function artifactsExist(workspace: string, artifacts: readonly Artifact[]): Promise<boolean> {
  for (const a of artifacts) {
    try {
      await stat(path.resolve(workspace, a.path));
    } catch {
      return false;
    }
  }
  return artifacts.length > 0;
}

export async function readArtifactBytes(workspace: string, artifact: Artifact): Promise<Uint8Array> {
  return readFile(path.resolve(workspace, artifact.path));
}
