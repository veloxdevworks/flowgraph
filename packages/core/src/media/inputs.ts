/**
 * Resolve a media node's `input:` value into concrete `MediaInput`s.
 *
 * Accepts, singly or in arrays: an Artifact, a media node's output
 * (`{ artifact, artifacts }`), a `{ path }` / `{ url }` object (for example a
 * `demo` node's output), a workspace path, an http(s) URL, or a data: URI.
 * Local paths must resolve inside the run workspace.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import type { Artifact } from "@flowgraph/spec";
import type { NodeRunContext } from "../context.js";
import { NODE_POLICY, NodePolicyError, type NodePolicy } from "../node-policy.js";
import { mimeForExtension, redactUrl } from "./artifacts.js";
import type { MediaInput } from "./types.js";

const MAX_REMOTE_INPUT_BYTES = 100 * 1024 * 1024;

type Item =
  | { kind: "path"; value: string; mimeType?: string | undefined; artifact?: Artifact | undefined }
  | { kind: "url"; value: string; mimeType?: string | undefined }
  | { kind: "data"; value: string };

function flatten(value: unknown, out: Item[]): void {
  if (value == null || value === "") return;
  if (Array.isArray(value)) {
    for (const v of value) flatten(v, out);
    return;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s.startsWith("data:")) out.push({ kind: "data", value: s });
    else if (/^https?:\/\//i.test(s)) out.push({ kind: "url", value: s });
    else if (s) out.push({ kind: "path", value: s });
    return;
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o["kind"] === "artifact" && typeof o["path"] === "string") {
      out.push({
        kind: "path",
        value: o["path"],
        mimeType: typeof o["mimeType"] === "string" ? o["mimeType"] : undefined,
        artifact: o as unknown as Artifact,
      });
      return;
    }
    if (Array.isArray(o["artifacts"])) return flatten(o["artifacts"], out);
    if (o["artifact"] && typeof o["artifact"] === "object") return flatten(o["artifact"], out);
    if (typeof o["path"] === "string") {
      out.push({ kind: "path", value: o["path"], mimeType: typeof o["mimeType"] === "string" ? o["mimeType"] : undefined });
      return;
    }
    if (typeof o["url"] === "string") {
      out.push({ kind: "url", value: o["url"], mimeType: typeof o["mimeType"] === "string" ? o["mimeType"] : undefined });
      return;
    }
  }
  throw new Error(`media input: cannot use a ${typeof value} value as an input (expected an Artifact, path, URL or data URI)`);
}

function toDataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

export interface ResolveInputsOptions {
  fetchImpl: typeof fetch;
  signal?: AbortSignal | undefined;
}

export async function resolveMediaInputs(
  value: unknown,
  ctx: NodeRunContext,
  opts: ResolveInputsOptions,
): Promise<MediaInput[]> {
  const items: Item[] = [];
  flatten(value, items);
  if (items.length === 0) return [];

  const policy = (ctx as unknown as Record<symbol, NodePolicy | undefined>)[NODE_POLICY];
  const workspaceReal = await realpath(ctx.workspace).catch(() => path.resolve(ctx.workspace));
  const inputs: MediaInput[] = [];

  for (const item of items) {
    if (item.kind === "url") {
      if (policy?.outboundHttp) {
        throw new NodePolicyError(
          "OUTBOUND_URL_BLOCKED",
          `media input URL ${redactUrl(item.value)} is not allowed: this graph runs under an outbound HTTP policy. Pass an Artifact or workspace path instead.`,
        );
      }
      const ext = path.extname(new URL(item.value).pathname).slice(1);
      const mimeType = item.mimeType ?? mimeForExtension(ext) ?? "application/octet-stream";
      let cached: Uint8Array | undefined;
      const bytes = async (): Promise<Uint8Array> => {
        if (cached) return cached;
        const res = await opts.fetchImpl(item.value, opts.signal ? { signal: opts.signal } : {});
        if (!res.ok) throw new Error(`media input download failed: HTTP ${res.status} for ${redactUrl(item.value)}`);
        const len = Number(res.headers.get("content-length") ?? 0);
        if (len > MAX_REMOTE_INPUT_BYTES) throw new Error(`media input too large (${len} bytes)`);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > MAX_REMOTE_INPUT_BYTES) throw new Error(`media input too large (${buf.byteLength} bytes)`);
        cached = buf;
        return buf;
      };
      inputs.push({
        ref: redactUrl(item.value),
        mimeType,
        url: item.value,
        identity: `url:${item.value}`,
        bytes,
        dataUri: async () => toDataUri(mimeType, await bytes()),
      });
    } else if (item.kind === "data") {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(item.value);
      if (!m) throw new Error("media input: malformed data: URI");
      const mimeType = m[1] ?? "application/octet-stream";
      const buf = m[2] ? Buffer.from(m[3]!, "base64") : Buffer.from(decodeURIComponent(m[3]!));
      const bytes = new Uint8Array(buf);
      inputs.push({
        ref: `data:${mimeType}`,
        mimeType,
        identity: `data:${mimeType}:${buf.length}:${buf.subarray(0, 64).toString("hex")}`,
        bytes: async () => bytes,
        dataUri: async () => item.value,
      });
    } else {
      const abs = path.resolve(ctx.workspace, item.value);
      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        throw new Error(`media input not found: ${item.value}`);
      }
      const rel = path.relative(workspaceReal, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`media input "${item.value}" is outside the run workspace`);
      }
      const st = await stat(real);
      const ext = path.extname(real).slice(1);
      const mimeType = item.mimeType ?? mimeForExtension(ext) ?? "application/octet-stream";
      inputs.push({
        ref: rel.split(path.sep).join("/"),
        mimeType,
        filePath: real,
        identity: item.artifact?.sha256 ? `sha256:${item.artifact.sha256}` : `file:${rel}:${st.size}:${Math.round(st.mtimeMs)}`,
        artifact: item.artifact,
        bytes: async () => new Uint8Array(await readFile(real)),
        dataUri: async () => toDataUri(mimeType, new Uint8Array(await readFile(real))),
      });
    }
  }
  return inputs;
}
