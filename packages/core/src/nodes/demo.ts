/**
 * Built-in node type: `demo`
 *
 * Best-effort artifact capture to demonstrate what a pipeline produced:
 *  - http: re-issue a request and save a request/response transcript
 *  - screenshot: navigate to a URL via Playwright and capture a screenshot
 *    (optional short video of the page load)
 *  - file: attach an existing file produced earlier in the pipeline
 *
 * Capture failures return `{ ok: false, reason }` unless `with.strict: true`.
 */

import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { DemoWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { parseDuration } from "../runtime/duration.js";
import { applyOutput } from "./output.js";
import { performHttpRequest, redactHeaders } from "./http-request.js";
import {
  appendDemoManifestEntry,
  demoManifestKey,
  type DemoKind,
  type DemoManifestEntry,
} from "./demo-manifest.js";

const configSchema = DemoWithSchema;
type Config = z.infer<typeof configSchema>;

export type { DemoKind };

export type DemoResult = {
  ok: boolean;
  kind: DemoKind;
  path?: string;
  mimeType?: string;
  sizeBytes?: number;
  reason?: string;
  capturedAt: string;
  label?: string;
  /** Present for http mode when capture succeeded. */
  request?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  response?: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
};

const MIME_BY_EXT: Record<string, string> = {
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

function mimeForPath(p: string): string {
  return MIME_BY_EXT[extname(p).toLowerCase()] ?? "application/octet-stream";
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "artifact"
  );
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Artifact dir: `<workspace>/.flowgraph/demo/<nodeId>/` */
export function demoArtifactDir(workspace: string, nodeId: string): string {
  return join(workspace, ".flowgraph", "demo", nodeId);
}

function ensureArtifactDir(workspace: string, nodeId: string): string {
  const dir = demoArtifactDir(workspace, nodeId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function resolvePath(workspace: string, p: string): string {
  return isAbsolute(p) ? p : resolve(workspace, p);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissingModuleError(err: unknown): boolean {
  const msg = errMessage(err);
  return (
    msg.includes("Cannot find module") ||
    msg.includes("Cannot find package") ||
    msg.includes("ERR_MODULE_NOT_FOUND") ||
    (err as NodeJS.ErrnoException)?.code === "ERR_MODULE_NOT_FOUND" ||
    (err as NodeJS.ErrnoException)?.code === "MODULE_NOT_FOUND"
  );
}

type PlaywrightModule = {
  chromium: {
    launch: (opts?: Record<string, unknown>) => Promise<{
      newContext: (opts?: Record<string, unknown>) => Promise<{
        newPage: () => Promise<{
          goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
          waitForSelector: (sel: string, opts?: Record<string, unknown>) => Promise<unknown>;
          waitForTimeout: (ms: number) => Promise<void>;
          screenshot: (opts?: Record<string, unknown>) => Promise<Buffer>;
        }>;
        close: () => Promise<void>;
      }>;
      close: () => Promise<void>;
    }>;
  };
};

async function importPlaywright(cwd: string): Promise<PlaywrightModule> {
  try {
    const req = createRequire(join(cwd, "package.json"));
    const resolved = req.resolve("playwright");
    return (await import(pathToFileURL(resolved).href)) as PlaywrightModule;
  } catch {
    // continue to bare import
  }
  try {
    return (await import("playwright")) as unknown as PlaywrightModule;
  } catch (err) {
    if (isMissingModuleError(err)) {
      throw new Error(
        "playwright is not installed. Run `npm install playwright` (or `pnpm add playwright`) in the graph workspace, then `npx playwright install chromium`.",
        { cause: err },
      );
    }
    throw err;
  }
}

function buildScope(state: Record<string, unknown>, ctx: NodeRunContext) {
  return {
    state,
    input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
    config: ctx.config,
    run: ctx.meta,
    secret: new Proxy({} as Record<string, string>, {
      get: (_t, prop) => process.env[String(prop)] ?? "",
    }),
  };
}

async function captureHttp(
  config: NonNullable<Config["http"]>,
  scope: ReturnType<typeof buildScope>,
  ctx: NodeRunContext,
  nodeId: string,
  label: string | undefined,
): Promise<DemoResult> {
  const url = String(renderDeep(config.url, scope));
  const method = config.method ?? "GET";
  const headers = config.headers
    ? (renderDeep(config.headers, scope) as Record<string, string>)
    : undefined;
  const body = config.body != null ? renderDeep(config.body, scope) : undefined;

  const httpResult = await performHttpRequest({
    method,
    url,
    ...(headers ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
    // Demo capture: accept any status so the transcript still records failures.
    expectStatus: "any",
    signal: ctx.signal ?? null,
  });

  const dir = ensureArtifactDir(ctx.workspace, nodeId);
  const fileName = `${timestampSlug()}-${slugify(label ?? "http")}.json`;
  const path = join(dir, fileName);

  const transcript = {
    label: label ?? null,
    capturedAt: new Date().toISOString(),
    request: {
      method: httpResult.method,
      url: httpResult.url,
      headers: redactHeaders(httpResult.requestHeaders),
      ...(httpResult.requestBody !== undefined ? { body: httpResult.requestBody } : {}),
    },
    response: {
      status: httpResult.status,
      headers: httpResult.headers,
      body: httpResult.body,
    },
  };
  writeFileSync(path, JSON.stringify(transcript, null, 2), "utf8");
  const sizeBytes = statSync(path).size;

  return {
    ok: true,
    kind: "http",
    path,
    mimeType: "application/json",
    sizeBytes,
    capturedAt: transcript.capturedAt,
    ...(label ? { label } : {}),
    request: transcript.request,
    response: transcript.response,
  };
}

async function captureScreenshot(
  config: NonNullable<Config["screenshot"]>,
  scope: ReturnType<typeof buildScope>,
  ctx: NodeRunContext,
  nodeId: string,
  label: string | undefined,
): Promise<DemoResult> {
  const url = String(renderDeep(config.url, scope));
  const timeoutMs = config.timeout ? parseDuration(config.timeout) : 30_000;
  const viewport = config.viewport ?? { width: 1280, height: 720 };

  const pw = await importPlaywright(ctx.workspace);
  const dir = ensureArtifactDir(ctx.workspace, nodeId);
  const slug = slugify(label ?? "screenshot");
  const shotName = `${timestampSlug()}-${slug}.png`;
  const shotPath = join(dir, shotName);

  const browser = await pw.chromium.launch({ headless: true });
  try {
    const contextOpts: Record<string, unknown> = {
      viewport,
      ...(config.video ? { recordVideo: { dir, size: viewport } } : {}),
    };
    const context = await browser.newContext(contextOpts);
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "load", timeout: timeoutMs });

      if (config.waitFor) {
        const waitFor = String(renderDeep(config.waitFor, scope));
        if (/^\d+(\.\d+)?(ms|s|m|h|d)$/.test(waitFor)) {
          await page.waitForTimeout(parseDuration(waitFor));
        } else {
          await page.waitForSelector(waitFor, { timeout: timeoutMs });
        }
      }

      await page.screenshot({ path: shotPath, fullPage: true });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const sizeBytes = statSync(shotPath).size;
  const capturedAt = new Date().toISOString();

  // When video recording is enabled, Playwright writes a .webm next to the context.
  // Prefer returning the screenshot path (primary artifact); video path is a bonus
  // left on disk under the same artifact dir for operators to find.
  return {
    ok: true,
    kind: "screenshot",
    path: shotPath,
    mimeType: "image/png",
    sizeBytes,
    capturedAt,
    ...(label ? { label } : {}),
  };
}

function captureFile(
  config: NonNullable<Config["file"]>,
  scope: ReturnType<typeof buildScope>,
  ctx: NodeRunContext,
  nodeId: string,
  label: string | undefined,
): DemoResult {
  const rawPath = String(renderDeep(config.path, scope));
  const source = resolvePath(ctx.workspace, rawPath);

  let st;
  try {
    st = statSync(source);
  } catch {
    throw new Error(`demo file: source not found: ${source}`);
  }
  if (!st.isFile()) {
    throw new Error(`demo file: source is not a file: ${source}`);
  }

  const dir = ensureArtifactDir(ctx.workspace, nodeId);
  const ext = extname(source) || "";
  const base = basename(source, ext);
  const dest = join(dir, `${timestampSlug()}-${slugify(label ?? base)}${ext}`);
  copyFileSync(source, dest);

  return {
    ok: true,
    kind: "file",
    path: dest,
    mimeType: mimeForPath(dest),
    sizeBytes: statSync(dest).size,
    capturedAt: new Date().toISOString(),
    ...(label ? { label } : {}),
  };
}

function failureResult(kind: DemoKind, reason: string, label?: string): DemoResult {
  return {
    ok: false,
    kind,
    reason,
    capturedAt: new Date().toISOString(),
    ...(label ? { label } : {}),
  };
}

function trackManifest(
  ctx: NodeRunContext,
  nodeId: string,
  result: DemoResult,
): void {
  try {
    const key = demoManifestKey({
      ...(ctx.meta?.threadId ? { threadId: ctx.meta.threadId } : {}),
      ...(ctx.meta?.runId ? { runId: ctx.meta.runId } : {}),
    });
    const entry: DemoManifestEntry = {
      ok: result.ok,
      kind: result.kind,
      nodeId,
      capturedAt: result.capturedAt,
      ...(result.path ? { path: result.path } : {}),
      ...(result.mimeType ? { mimeType: result.mimeType } : {}),
      ...(result.sizeBytes != null ? { sizeBytes: result.sizeBytes } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.label ? { label: result.label } : {}),
    };
    appendDemoManifestEntry(ctx.workspace, key, entry);
  } catch (err) {
    ctx.logger.warn("demo: failed to append manifest entry", {
      reason: errMessage(err),
    });
  }
}

export const demoNode = defineNode<Config>({
  type: "demo",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: { sideEffecting: true },

  build(_ctx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    return {
      contract: {},
      capabilities: { sideEffecting: true },

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const scope = buildScope(state, ctx);
        const nodeId = String(nodeSpec["id"] ?? ctx.nodeId);
        const label = config.label
          ? String(renderDeep(config.label, scope))
          : undefined;
        const strict = config.strict === true;

        let kind: DemoKind;
        if (config.http) kind = "http";
        else if (config.screenshot) kind = "screenshot";
        else if (config.file) kind = "file";
        else {
          // Schema should prevent this; treat as best-effort failure.
          const result = failureResult("http", "demo: no capture mode configured", label);
          if (strict) throw new Error(result.reason);
          ctx.logger.warn(result.reason!);
          trackManifest(ctx, nodeId, result);
          ctx.emit("node.output", result);
          return {
            update: applyOutput(config.output, result, { nodeId, scope }),
          };
        }

        try {
          let result: DemoResult;
          if (kind === "http" && config.http) {
            result = await captureHttp(config.http, scope, ctx, nodeId, label);
          } else if (kind === "screenshot" && config.screenshot) {
            result = await captureScreenshot(config.screenshot, scope, ctx, nodeId, label);
          } else {
            result = captureFile(config.file!, scope, ctx, nodeId, label);
          }

          trackManifest(ctx, nodeId, result);
          ctx.emit("node.output", result);
          return {
            update: applyOutput(config.output, result, { nodeId, scope }),
          };
        } catch (err) {
          const reason = errMessage(err);
          if (strict) throw err instanceof Error ? err : new Error(reason);
          const result = failureResult(kind, reason, label);
          ctx.logger.warn(`demo: capture failed (${kind})`, { reason });
          trackManifest(ctx, nodeId, result);
          ctx.emit("node.output", result);
          return {
            update: applyOutput(config.output, result, { nodeId, scope }),
          };
        }
      },
    };
  },
});
