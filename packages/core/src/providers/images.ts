import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { NodeRunContext } from "../context.js";
import { nodePolicyOf, NodePolicyError } from "../node-policy.js";
import { guardedFetch } from "../outbound-http.js";
import { probeImageSize, toPosix } from "../media/artifacts.js";
import { DEFAULT_IMAGE_TOKENS, type ImageAttachment } from "./types.js";

export const MAX_AGENT_IMAGES = 16;
export const MAX_AGENT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_AGENT_IMAGE_TOTAL_BYTES = 50 * 1024 * 1024;
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
type ImageDetail = "auto" | "low" | "high";

export function imageError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: false });
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
function snapshotRoot(ctx: NodeRunContext, workspace = ctx.workspace): string {
  const scope = ctx.meta.threadId ?? ctx.meta.runId;
  if (!scope) throw imageError("IMAGE_ATTACHMENT_INVALID", "Image inputs require a scoped run");
  // Full thread hashes avoid collisions from sanitized or truncated thread ids.
  return path.join(workspace, ".flowgraph", "agent-images", digest(Buffer.from(scope)));
}
function imageMime(bytes: Buffer): string {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (bytes.length >= 10 && /GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii")))
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  throw imageError(
    "IMAGE_FORMAT_UNSUPPORTED",
    "Agent image input must contain PNG, JPEG, GIF or WebP bytes",
  );
}
function controls(value: Record<string, unknown>): { detail: ImageDetail; tokens: number } {
  const meta =
    value.meta && typeof value.meta === "object" ? (value.meta as Record<string, unknown>) : {};
  const detail = value.detail ?? meta.imageDetail ?? "auto";
  const tokens = value.estimatedTokens ?? meta.imageTokens ?? DEFAULT_IMAGE_TOKENS;
  if (
    typeof detail !== "string" ||
    !["auto", "low", "high"].includes(detail) ||
    typeof tokens !== "number" ||
    !Number.isSafeInteger(tokens) ||
    tokens <= 0
  ) {
    throw imageError("IMAGE_INPUT_INVALID", "Image detail and estimatedTokens must be valid");
  }
  return { detail: detail as ImageDetail, tokens };
}
async function localImage(file: string, ctx: NodeRunContext): Promise<Buffer> {
  const workspace = await realpath(ctx.workspace);
  const absolute = path.resolve(workspace, file);
  const policy = nodePolicyOf(ctx);
  if (policy?.blockImageFiles && !inside(snapshotRoot(ctx, workspace), absolute)) {
    throw new NodePolicyError(
      "IMAGE_FILE_BLOCKED",
      `agent node "${ctx.nodeId}": local image files are not allowed by this host`,
    );
  }
  const resolved = await realpath(absolute);
  if (!inside(workspace, resolved))
    throw imageError("IMAGE_PATH_OUTSIDE_WORKSPACE", "Image path leaves the graph workspace");
  if (policy?.blockImageFiles && !inside(await realpath(snapshotRoot(ctx, workspace)), resolved)) {
    throw new NodePolicyError(
      "IMAGE_FILE_BLOCKED",
      "Image snapshot leaves this thread's image directory",
    );
  }
  const info = await stat(resolved);
  if (!info.isFile()) throw imageError("IMAGE_INPUT_INVALID", "Image input must be a regular file");
  if (info.size > MAX_AGENT_IMAGE_BYTES)
    throw imageError("IMAGE_TOO_LARGE", "Agent image exceeds the 20 MiB limit");
  return readFile(resolved, ctx.signal ? { signal: ctx.signal } : undefined);
}
async function sourceBytes(source: string, ctx: NodeRunContext): Promise<Buffer> {
  if (source.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(source);
    if (!match)
      throw imageError(
        "IMAGE_INPUT_INVALID",
        "Image data URLs require a supported MIME type and base64 encoding",
      );
    if (match[2]!.length > Math.ceil(MAX_AGENT_IMAGE_BYTES / 3) * 4 + 4)
      throw imageError("IMAGE_TOO_LARGE", "Agent image exceeds the 20 MiB limit");
    const bytes = Buffer.from(match[2]!, "base64");
    if (imageMime(bytes) !== match[1])
      throw imageError("IMAGE_FORMAT_UNSUPPORTED", "Image MIME type does not match its bytes");
    return bytes;
  }
  if (/^https?:\/\//i.test(source)) {
    const policy = nodePolicyOf(ctx)?.outboundHttp;
    try {
      const response = await guardedFetch(
        source,
        { ...(ctx.signal ? { signal: ctx.signal } : {}) },
        {
          publicOnly: policy?.publicOnly ?? false,
          ...(policy?.allowHosts ? { allowHosts: policy.allowHosts } : {}),
          maxResponseBytes: Math.min(
            policy?.maxResponseBytes ?? MAX_AGENT_IMAGE_BYTES,
            MAX_AGENT_IMAGE_BYTES,
          ),
          timeoutMs: Math.min(policy?.timeoutMs ?? 30000, 30000),
          maxRedirects: policy?.maxRedirects ?? 5,
        },
      );
      if (!response.ok)
        throw imageError("IMAGE_FETCH_FAILED", `Image download returned HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (cause) {
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      // Source URLs may carry signed query strings; keep them out of errors.
      const code = (cause as { code?: unknown })?.code;
      throw imageError(
        typeof code === "string" ? code : "IMAGE_FETCH_FAILED",
        "Agent image download failed or was refused by the host network policy",
      );
    }
  }
  return localImage(source, ctx);
}
function flatten(input: unknown, depth = 0): unknown[] {
  if (depth > 8) throw imageError("IMAGE_INPUT_INVALID", "Image inputs are nested too deeply");
  if (!Array.isArray(input)) return [input];
  const out: unknown[] = [];
  for (const value of input) {
    out.push(...flatten(value, depth + 1));
    if (out.length > MAX_AGENT_IMAGES)
      throw imageError("IMAGE_INPUT_INVALID", "An agent turn supports at most 16 images");
  }
  return out;
}

export async function resolveAgentImages(
  input: unknown,
  ctx: NodeRunContext,
): Promise<ImageAttachment[]> {
  const workspace = await realpath(ctx.workspace);
  const refs = flatten(input);
  const out: ImageAttachment[] = [];
  let total = 0;
  for (const ref of refs) {
    ctx.signal?.throwIfAborted();
    const object =
      typeof ref === "string"
        ? {}
        : ref && typeof ref === "object"
          ? (ref as Record<string, unknown>)
          : undefined;
    if (!object)
      throw imageError("IMAGE_INPUT_INVALID", "Image inputs must be a path, URL or Artifact");
    const source = typeof ref === "string" ? ref : (object.path ?? object.url);
    if (
      typeof source !== "string" ||
      !source.trim() ||
      (object.path !== undefined && object.url !== undefined)
    ) {
      throw imageError("IMAGE_INPUT_INVALID", "An image requires exactly one nonempty path or URL");
    }
    const { detail, tokens } = controls(object);
    const bytes = await sourceBytes(source, ctx);
    total += bytes.byteLength;
    if (bytes.byteLength > MAX_AGENT_IMAGE_BYTES || total > MAX_AGENT_IMAGE_TOTAL_BYTES)
      throw imageError("IMAGE_TOO_LARGE", "Agent images exceed the per-image or 50 MiB turn limit");
    const mimeType = imageMime(bytes),
      sha256 = digest(bytes);
    if (
      typeof object.mimeType === "string" &&
      object.mimeType.replace("image/jpg", "image/jpeg") !== mimeType
    )
      throw imageError("IMAGE_FORMAT_UNSUPPORTED", "Image MIME type does not match its bytes");
    if (object.sha256 !== undefined && object.sha256 !== sha256)
      throw imageError(
        "IMAGE_CONTENT_CHANGED",
        "Image content no longer matches its Artifact checksum",
      );
    const root = snapshotRoot(ctx, workspace);
    await mkdir(root, { recursive: true });
    const realRoot = await realpath(root);
    if (!inside(await realpath(ctx.workspace), realRoot))
      throw imageError(
        "IMAGE_PATH_OUTSIDE_WORKSPACE",
        "Image snapshot directory leaves the workspace",
      );
    const file = path.join(realRoot, `${sha256}.${EXT[mimeType]}`);
    const tmp = path.join(realRoot, `.${sha256}.${randomBytes(8).toString("hex")}.partial`);
    try {
      await writeFile(tmp, bytes, { flag: "wx", ...(ctx.signal ? { signal: ctx.signal } : {}) });
      await rename(tmp, file);
    } finally {
      await rm(tmp, { force: true });
    }
    const size = probeImageSize(bytes);
    out.push({
      kind: "artifact",
      role: "image",
      path: toPosix(path.relative(workspace, file)),
      mimeType,
      sha256,
      sizeBytes: bytes.byteLength,
      meta: {
        imageDetail: detail,
        imageTokens: tokens,
        ...(size ? { width: size.width, height: size.height } : {}),
      },
    });
  }
  return out;
}

/** Materialize immutable references only at a model-call boundary. */
export async function imageContentBlocks(images: ImageAttachment[], ctx: NodeRunContext) {
  if (images.length > MAX_AGENT_IMAGES)
    throw imageError("IMAGE_INPUT_INVALID", "A model message supports at most 16 images");
  const out: Array<{ type: "image_url"; image_url: { url: string; detail: ImageDetail } }> = [];
  let total = 0;
  for (const image of images) {
    if (
      !image ||
      image.kind !== "artifact" ||
      image.role !== "image" ||
      typeof image.path !== "string" ||
      !/^[a-f0-9]{64}$/.test(image.sha256)
    )
      throw imageError("IMAGE_ATTACHMENT_INVALID", "Stored image attachment is invalid");
    const bytes = await localImage(image.path, ctx);
    total += bytes.length;
    if (total > MAX_AGENT_IMAGE_TOTAL_BYTES)
      throw imageError("IMAGE_TOO_LARGE", "Model image inputs exceed 50 MiB");
    if (
      digest(bytes) !== image.sha256 ||
      imageMime(bytes) !== image.mimeType ||
      bytes.length !== image.sizeBytes
    )
      throw imageError(
        "IMAGE_CONTENT_CHANGED",
        "Stored image content no longer matches its Artifact",
      );
    out.push({
      type: "image_url",
      image_url: {
        url: `data:${image.mimeType};base64,${bytes.toString("base64")}`,
        detail: controls(image).detail,
      },
    });
  }
  return out;
}

export function assertImageBatch(images: ImageAttachment[]): void {
  if (images.length > MAX_AGENT_IMAGES)
    throw imageError("IMAGE_INPUT_INVALID", "A model call supports at most 16 retained images");
  const bytes = images.reduce((total, image) => total + image.sizeBytes, 0);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_AGENT_IMAGE_TOTAL_BYTES)
    throw imageError("IMAGE_TOO_LARGE", "Retained model image inputs exceed 50 MiB");
}
