/**
 * Built-in node type: `demo`
 *
 * Best-effort artifact capture to demonstrate what a pipeline produced:
 *  - http: re-issue a request and save a request/response transcript
 *  - screenshot: navigate to a URL via Playwright and capture a screenshot
 *    (optional short video of the page load, tracked as an extra artifact)
 *  - video: record a short page-load video via Playwright
 *  - simulator: iOS (simctl) or Android (adb) screenshot / video
 *  - file: attach an existing file produced earlier in the pipeline
 *
 * `ok` means the capture worked AND what it recorded is not a failure. A capture
 * that recorded a failure (HTTP 500, an error page) keeps its file as evidence and
 * reports `{ ok: false, reason, path }`. Failures return rather than throw unless
 * `with.strict: true`.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { DemoWithSchema } from "@flowgraph/spec";
import { renderDeep } from "@flowgraph/expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { parseDuration } from "../runtime/duration.js";
import { applyOutput } from "./output.js";
import {
  performHttpRequest,
  redactHeaders,
  redactSensitiveFields,
  redactUrlSecrets,
} from "./http-request.js";
import { createRedactor, DEFAULT_REDACT_PATTERNS } from "../secrets.js";
import { WORKTREES_CHANNEL } from "../runtime/state-annotation.js";
import {
  BROWSER_INSTALL_COMMAND,
  importPlaywright,
  isMissingBrowserError,
  missingBrowserMessage,
  type PlaywrightPage,
  type PlaywrightResponse,
} from "./demo-playwright.js";
import {
  appendDemoManifestEntry,
  demoManifestKey,
  type DemoKind,
  type DemoManifestEntry,
  type DemoExtraArtifact,
} from "./demo-manifest.js";
import { ISSUE_CODE } from "../runtime/run-issues.js";
import { captureSimulator, type SimulatorConfig } from "./demo-simulator.js";

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
  extra?: DemoExtraArtifact[];
  /** Screenshot and video modes: the HTTP status of the page that was opened. */
  pageStatus?: number;
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

/** Why a status is not success, or undefined when it is. */
function statusFailure(
  what: string,
  status: number | undefined,
  expected: { status: number[] } | undefined,
): string | undefined {
  if (status === undefined) return undefined;
  if (expected ? expected.status.includes(status) : status < 400) return undefined;
  const wanted = expected ? `, expected ${expected.status.join(" or ")}` : "";
  return `${what} returned HTTP ${status}${wanted}`;
}

/** An empty file proves nothing, so it never counts as a capture. */
function assertNotEmpty(path: string, what: string): number {
  const size = statSync(path).size;
  if (size === 0) throw new Error(`${what} produced an empty file`);
  return size;
}

function pageStatusOf(response: PlaywrightResponse | null): number | undefined {
  return response ? response.status() : undefined;
}

async function waitForPage(
  page: PlaywrightPage,
  waitFor: string | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!waitFor) return;
  if (/^\d+(\.\d+)?(ms|s|m|h|d)$/.test(waitFor)) {
    await page.waitForTimeout(parseDuration(waitFor));
  } else {
    await page.waitForSelector(waitFor, { timeout: timeoutMs });
  }
}

function buildScope(
  state: Record<string, unknown>,
  ctx: NodeRunContext,
  usedSecrets: Set<string>,
) {
  return {
    state,
    input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
    config: ctx.config,
    run: ctx.meta,
    secret: new Proxy({} as Record<string, string>, {
      get: (_t, prop) => {
        const value = process.env[String(prop)] ?? "";
        if (value) usedSecrets.add(value);
        return value;
      },
    }),
  };
}

async function captureHttp(
  config: NonNullable<Config["http"]>,
  scope: ReturnType<typeof buildScope>,
  ctx: NodeRunContext,
  nodeId: string,
  label: string | undefined,
  usedSecrets: ReadonlySet<string>,
): Promise<DemoResult> {
  const url = String(renderDeep(config.url, scope));
  const method = config.method ?? "GET";
  const headers = config.headers
    ? (renderDeep(config.headers, scope) as Record<string, string>)
    : undefined;
  const body = config.body != null ? renderDeep(config.body, scope) : undefined;

  const timeout = config.timeout ?? "30s";
  const timeoutSignal = AbortSignal.timeout(parseDuration(timeout));
  let httpResult;
  try {
    httpResult = await performHttpRequest({
      method,
      url,
      ...(headers ? { headers } : {}),
      ...(body !== undefined ? { body } : {}),
      // Accept any status here so the transcript still records failures; `ok` is judged below.
      expectStatus: "any",
      signal: ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal,
    });
  } catch (err) {
    if (timeoutSignal.aborted) {
      throw new Error(`${method} ${redactUrlSecrets(url)} did not respond within ${timeout}`, { cause: err });
    }
    throw err;
  }

  const dir = ensureArtifactDir(ctx.workspace, nodeId);
  const fileName = `${timestampSlug()}-${slugify(label ?? "http")}.json`;
  const path = join(dir, fileName);

  // Transcripts are shared as evidence and also land in graph state: mask credentials
  // by name, then any secret this node rendered, wherever a server echoed it back.
  const redact = createRedactor([...usedSecrets], DEFAULT_REDACT_PATTERNS);
  const transcript = redact({
    label: label ?? null,
    capturedAt: new Date().toISOString(),
    request: {
      method: httpResult.method,
      url: redactUrlSecrets(httpResult.url),
      headers: redactHeaders(httpResult.requestHeaders),
      ...(httpResult.requestBody !== undefined
        ? { body: redactSensitiveFields(httpResult.requestBody) }
        : {}),
    },
    response: {
      status: httpResult.status,
      headers: redactHeaders(httpResult.headers),
      body: redactSensitiveFields(httpResult.body),
    },
  }) as {
    capturedAt: string;
    request: NonNullable<DemoResult["request"]>;
    response: NonNullable<DemoResult["response"]>;
  };
  writeFileSync(path, JSON.stringify(transcript, null, 2), "utf8");
  const sizeBytes = statSync(path).size;
  const failure = statusFailure(
    `${httpResult.method} ${transcript.request.url}`,
    httpResult.status,
    config.expect,
  );

  return {
    ok: !failure,
    ...(failure ? { reason: failure } : {}),
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
  let extra: DemoExtraArtifact | undefined;
  let pageStatus: number | undefined;
  try {
    const contextOpts: Record<string, unknown> = {
      viewport,
      ...(config.video ? { recordVideo: { dir, size: viewport } } : {}),
    };
    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();
    const videoHandle = config.video && typeof page.video === "function" ? page.video() : null;
    try {
      pageStatus = pageStatusOf(await page.goto(url, { waitUntil: "load", timeout: timeoutMs }));
      await waitForPage(
        page,
        config.waitFor ? String(renderDeep(config.waitFor, scope)) : undefined,
        timeoutMs,
      );
      await page.screenshot({ path: shotPath, fullPage: true });
    } finally {
      await context.close();
    }
    if (videoHandle) {
      extra = await videoHandleToExtra(videoHandle, dir, slug);
    }
  } finally {
    await browser.close();
  }

  const sizeBytes = assertNotEmpty(shotPath, "demo screenshot");
  const capturedAt = new Date().toISOString();
  const failure = statusFailure(`page ${redactUrlSecrets(url)}`, pageStatus, config.expect);

  return {
    ok: !failure,
    ...(failure ? { reason: failure } : {}),
    ...(pageStatus !== undefined ? { pageStatus } : {}),
    kind: "screenshot",
    path: shotPath,
    mimeType: "image/png",
    sizeBytes,
    capturedAt,
    ...(label ? { label } : {}),
    ...(extra ? { extra: [extra] } : {}),
  };
}

async function videoHandleToExtra(
  handle: { path: () => Promise<string> },
  destDir: string,
  slug: string,
): Promise<DemoExtraArtifact | undefined> {
  try {
    const raw = await handle.path();
    if (!raw || !existsSync(raw)) return undefined;
    const dest = join(destDir, `${timestampSlug()}-${slug}.webm`);
    // Playwright records under a random name in this same directory: move it, don't copy.
    renameSync(raw, dest);
    const sizeBytes = statSync(dest).size;
    if (sizeBytes === 0) return undefined;
    return { path: dest, mimeType: "video/webm", kind: "video", sizeBytes };
  } catch {
    return undefined;
  }
}

async function captureVideo(
  config: NonNullable<Config["video"]>,
  scope: ReturnType<typeof buildScope>,
  ctx: NodeRunContext,
  nodeId: string,
  label: string | undefined,
): Promise<DemoResult> {
  const url = String(renderDeep(config.url, scope));
  const timeoutMs = config.timeout ? parseDuration(config.timeout) : 30_000;
  const durationMs = config.duration ? parseDuration(config.duration) : 5_000;
  const viewport = config.viewport ?? { width: 1280, height: 720 };

  const pw = await importPlaywright(ctx.workspace);
  const dir = ensureArtifactDir(ctx.workspace, nodeId);
  const slug = slugify(label ?? "video");

  const browser = await pw.chromium.launch({ headless: true });
  let videoPath: string | undefined;
  let pageStatus: number | undefined;
  try {
    const context = await browser.newContext({
      viewport,
      recordVideo: { dir, size: viewport },
    });
    const page = await context.newPage();
    const videoHandle = typeof page.video === "function" ? page.video() : null;
    try {
      pageStatus = pageStatusOf(await page.goto(url, { waitUntil: "load", timeout: timeoutMs }));
      await waitForPage(
        page,
        config.waitFor ? String(renderDeep(config.waitFor, scope)) : undefined,
        timeoutMs,
      );
      if (config.scroll) {
        const steps = Math.max(3, Math.floor(durationMs / 400));
        for (let i = 0; i < steps; i++) {
          await page.evaluate("window.scrollBy(0, Math.floor(window.innerHeight * 0.4))");
          await page.waitForTimeout(Math.floor(durationMs / steps));
        }
      } else {
        await page.waitForTimeout(durationMs);
      }
    } finally {
      await context.close();
    }
    if (videoHandle) {
      const extra = await videoHandleToExtra(videoHandle, dir, slug);
      videoPath = extra?.path;
    }
  } finally {
    await browser.close();
  }

  if (!videoPath || !existsSync(videoPath)) {
    throw new Error("demo video: Playwright did not produce a recording");
  }
  const failure = statusFailure(`page ${redactUrlSecrets(url)}`, pageStatus, config.expect);
  return {
    ok: !failure,
    ...(failure ? { reason: failure } : {}),
    ...(pageStatus !== undefined ? { pageStatus } : {}),
    kind: "video",
    path: videoPath,
    mimeType: "video/webm",
    sizeBytes: statSync(videoPath).size,
    capturedAt: new Date().toISOString(),
    ...(label ? { label } : {}),
  };
}

/** Files a capture may attach: the run workspace and this thread's own worktrees. */
function assertAttachable(source: string, state: Record<string, unknown>, workspace: string): void {
  const worktrees = Array.isArray(state[WORKTREES_CHANNEL])
    ? (state[WORKTREES_CHANNEL] as Array<{ path?: unknown }>).flatMap((w) =>
        typeof w?.path === "string" ? [w.path] : [],
      )
    : [];
  const real = realpathSync(source);
  for (const root of [workspace, ...worktrees]) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    const rel = relative(realRoot, real);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return;
  }
  throw new Error(`demo file: source is outside the run workspace: ${source}`);
}

function captureFile(
  config: NonNullable<Config["file"]>,
  state: Record<string, unknown>,
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
  assertAttachable(source, state, ctx.workspace);

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
    sizeBytes: assertNotEmpty(dest, "demo file"),
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
      ...(result.extra && result.extra.length > 0 ? { extra: result.extra } : {}),
    };
    appendDemoManifestEntry(ctx.workspace, key, entry);
  } catch (err) {
    ctx.logger.warn("demo: failed to append manifest entry", {
      reason: errMessage(err),
    });
  }
}

/** A fix to suggest, only when the failure really is a missing tool. */
function remediationFor(reason: string): string | undefined {
  if (/playwright is not installed/i.test(reason)) {
    return `Install playwright (\`npm install playwright\`), then run \`${BROWSER_INSTALL_COMMAND}\`.`;
  }
  if (/browser is not installed/i.test(reason)) return `Run \`${BROWSER_INSTALL_COMMAND}\`.`;
  if (/(xcrun|simctl) is not installed/i.test(reason)) {
    return "Install Xcode (simctl is not in the command-line tools) and select it with `sudo xcode-select -s /Applications/Xcode.app`.";
  }
  if (/adb is not installed/i.test(reason)) {
    return "Install the Android SDK platform-tools and ensure adb is on PATH.";
  }
  return undefined;
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
        const usedSecrets = new Set<string>();
        const scope = buildScope(state, ctx, usedSecrets);
        const nodeId = String(nodeSpec["id"] ?? ctx.nodeId);
        const label = config.label
          ? String(renderDeep(config.label, scope))
          : undefined;
        const strict = config.strict === true;

        let kind: DemoKind;
        if (config.http) kind = "http";
        else if (config.screenshot) kind = "screenshot";
        else if (config.video) kind = "video";
        else if (config.simulator) kind = "simulator";
        else if (config.file) kind = "file";
        else {
          // Schema should prevent this; treat as best-effort failure.
          const result = failureResult("http", "demo: no capture mode configured", label);
          ctx.issue({
            code: ISSUE_CODE.CAPTURE_FAILED,
            severity: "warning",
            message: result.reason!,
            impact: "No demo artifact was captured.",
          });
          ctx.logger.warn(result.reason!);
          trackManifest(ctx, nodeId, result);
          if (strict) throw new Error(result.reason);
          ctx.emit("node.output", result);
          return {
            update: applyOutput(config.output, result, { nodeId, scope }),
          };
        }

        let result: DemoResult;
        let cause: unknown;
        try {
          if (kind === "http" && config.http) {
            result = await captureHttp(config.http, scope, ctx, nodeId, label, usedSecrets);
          } else if (kind === "screenshot" && config.screenshot) {
            result = await captureScreenshot(config.screenshot, scope, ctx, nodeId, label);
          } else if (kind === "video" && config.video) {
            result = await captureVideo(config.video, scope, ctx, nodeId, label);
          } else if (kind === "simulator" && config.simulator) {
            const dir = ensureArtifactDir(ctx.workspace, nodeId);
            const slug = `${timestampSlug()}-${slugify(label ?? "simulator")}`;
            const sim = await captureSimulator(renderDeep(config.simulator, scope) as SimulatorConfig, {
              artifactDir: dir,
              fileSlug: slug,
            });
            result = {
              ok: true,
              kind: "simulator",
              path: sim.path,
              mimeType: sim.mimeType,
              sizeBytes: sim.sizeBytes,
              capturedAt: new Date().toISOString(),
              ...(label ? { label } : {}),
            };
            if (sim.warning) {
              ctx.issue({
                code: ISSUE_CODE.CAPTURE_FAILED,
                severity: "warning",
                message: `demo simulator capture may be misleading: ${sim.warning}`,
                impact: "Check the artifact by eye. Raise `simulator.settle` if the app needs longer to open.",
                detail: { kind, reason: sim.warning },
              });
              ctx.logger.warn("demo: simulator capture may be misleading", { reason: sim.warning });
            }
          } else {
            result = captureFile(config.file!, state, scope, ctx, nodeId, label);
          }
        } catch (err) {
          cause = err;
          const redact = createRedactor([...usedSecrets], DEFAULT_REDACT_PATTERNS);
          const reason = String(
            redact(isMissingBrowserError(err) ? missingBrowserMessage() : errMessage(err)),
          );
          result = failureResult(kind, reason, label);
          const remediation = remediationFor(reason);
          ctx.issue({
            code: remediation ? ISSUE_CODE.TOOL_NOT_FOUND : ISSUE_CODE.CAPTURE_FAILED,
            severity: "warning",
            message: `demo ${kind} capture failed: ${reason}`,
            impact: "The expected demo artifact is missing; the run result is harder to verify.",
            ...(remediation ? { remediation } : {}),
            detail: { kind, reason },
          });
          ctx.logger.warn(`demo: capture failed (${kind})`, { reason });
        }

        // A capture can work and still record a failure (HTTP 500): the file stays as evidence.
        if (!cause && !result.ok) {
          ctx.issue({
            code: ISSUE_CODE.CAPTURE_FAILED,
            severity: "warning",
            message: `demo ${kind} capture recorded a failure: ${result.reason}`,
            impact: "The artifact shows a failure, so it does not demonstrate the expected result.",
            detail: { kind, reason: result.reason },
          });
          ctx.logger.warn(`demo: capture recorded a failure (${kind})`, { reason: result.reason });
        }

        trackManifest(ctx, nodeId, result);
        if (strict && !result.ok) throw new Error(result.reason, { cause });
        ctx.emit("node.output", result);
        return {
          update: applyOutput(config.output, result, { nodeId, scope }),
        };
      },
    };
  },
});
