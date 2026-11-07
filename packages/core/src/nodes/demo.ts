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
 * `status` says what the result shows (ADR-0019 §3). These modes check nothing about
 * an objective, so they can only be:
 *  - `inconclusive`: the capture worked and recorded no failure (`ok: true`)
 *  - `failed`: the capture worked and recorded a failure (HTTP 500, an error page).
 *    The file stays as evidence (`ok: false`)
 *  - `not_captured`: nothing was captured, so there is no file (`ok: false`)
 * `ok` is derived from `status`. Failures return rather than throw unless
 * `with.strict: true`.
 *
 * Every field is written on every run, `null` when absent, because `outputs` is
 * deep-merged and a missing field would keep the previous run's value. Files go under
 * `.flowgraph/artifacts/<threadKey>/<nodeId>/` and `artifacts` lists their records.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { DemoWithSchema, type Artifact, type DemoStatus } from "@flowgraph/spec";
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
import { artifactDir, describeArtifactFile } from "../media/artifacts.js";
import { runScopedKey } from "../runtime/run-key.js";
import { WORKTREES_CHANNEL } from "../runtime/state-annotation.js";
import {
  BROWSER_INSTALL_COMMAND,
  closeOnAbort,
  importPlaywright,
  launchCaptureBrowser,
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

/** Every field is always present: `null` (or `[]` for `artifacts`) when it does not apply. */
export type DemoResult = {
  /** Derived from `status`: true for `passed` and `inconclusive`. */
  ok: boolean;
  status: DemoStatus;
  kind: DemoKind;
  /** Absolute path of the main file. Kept for existing graphs: prefer `artifacts`. */
  path: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  reason: string | null;
  capturedAt: string;
  label: string | null;
  /** Absolute paths of files kept beside the main one, such as a page-load recording. */
  extra: DemoExtraArtifact[] | null;
  /** Screenshot and video modes: the HTTP status of the page that was opened. */
  pageStatus: number | null;
  /** http mode, when the request was made. */
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  } | null;
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  } | null;
  /** Workspace-relative records of every file kept, the main file first. */
  artifacts: Artifact[];
};

/** What a capture function hands back; `toResult` turns it into a `DemoResult`. */
type Captured = {
  path: string;
  mimeType: string;
  sizeBytes: number;
  capturedAt: string;
  /** Set when the capture worked but recorded a failure. */
  failure?: string | undefined;
  pageStatus?: number | undefined;
  extra?: DemoExtraArtifact[] | undefined;
  request?: DemoResult["request"];
  response?: DemoResult["response"];
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

/** Artifact dir: `<workspace>/.flowgraph/artifacts/<threadKey>/<nodeId>/`, as for media nodes. */
export function demoArtifactDir(workspace: string, threadKey: string, nodeId: string): string {
  return artifactDir(workspace, threadKey, nodeId);
}

/** The key that scopes this run's files and manifest: the thread, so resumes share it. */
function threadKeyOf(ctx: NodeRunContext): string {
  return runScopedKey({
    ...(ctx.meta?.threadId ? { threadId: ctx.meta.threadId } : {}),
    ...(ctx.meta?.runId ? { runId: ctx.meta.runId } : {}),
  });
}

function ensureArtifactDir(ctx: NodeRunContext, nodeId: string): string {
  const dir = demoArtifactDir(ctx.workspace, threadKeyOf(ctx), nodeId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove a half-written file so a failed capture leaves nothing that looks like evidence. */
function discard(path: string): void {
  rmSync(path, { force: true });
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
): Promise<Captured> {
  const url = String(renderDeep(config.url, scope));
  const method = config.method ?? "GET";
  const headers = config.headers
    ? (renderDeep(config.headers, scope) as Record<string, string>)
    : undefined;
  const body = config.body != null ? renderDeep(config.body, scope) : undefined;

  ctx.signal?.throwIfAborted();
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
    // A cancelled run is not a timeout, even when both fired.
    if (ctx.signal?.aborted) throw err;
    if (timeoutSignal.aborted) {
      throw new Error(`${method} ${redactUrlSecrets(url)} did not respond within ${timeout}`, { cause: err });
    }
    throw err;
  }

  const dir = ensureArtifactDir(ctx, nodeId);
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
    failure,
    path,
    mimeType: "application/json",
    sizeBytes,
    capturedAt: transcript.capturedAt,
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
): Promise<Captured> {
  const url = String(renderDeep(config.url, scope));
  const timeoutMs = config.timeout ? parseDuration(config.timeout) : 30_000;
  const viewport = config.viewport ?? { width: 1280, height: 720 };

  const pw = await importPlaywright(ctx.workspace);
  ctx.signal?.throwIfAborted();
  const dir = ensureArtifactDir(ctx, nodeId);
  const slug = slugify(label ?? "screenshot");
  const shotName = `${timestampSlug()}-${slug}.png`;
  const shotPath = join(dir, shotName);

  const browser = await launchCaptureBrowser(pw, ctx.signal);
  // Cancelling closes the context, which rejects whatever Playwright call is in flight.
  const onAbort = closeOnAbort(ctx.signal);
  onAbort.add(() => browser.close());
  onAbort.now(() => discard(shotPath));
  let extra: DemoExtraArtifact | undefined;
  let pageStatus: number | undefined;
  let scratch: string | undefined;
  try {
    // Playwright names recordings itself: let it write to a scratch folder, so a capture
    // that fails after the page opened leaves no stray recording among the artifacts.
    scratch = config.video ? mkdtempSync(join(dir, ".recording-")) : undefined;
    if (scratch) {
      const folder = scratch;
      onAbort.now(() => rmSync(folder, { recursive: true, force: true }));
    }
    const contextOpts: Record<string, unknown> = {
      viewport,
      ...(scratch ? { recordVideo: { dir: scratch, size: viewport } } : {}),
    };
    const context = await browser.newContext(contextOpts);
    onAbort.add(() => context.close());
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
  } catch (err) {
    discard(shotPath);
    throw err;
  } finally {
    onAbort.dispose();
    await browser.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }

  let sizeBytes: number;
  try {
    // Cancelled while the browser was closing: the run is over, so keep nothing of it.
    ctx.signal?.throwIfAborted();
    sizeBytes = assertNotEmpty(shotPath, "demo screenshot");
  } catch (err) {
    discard(shotPath);
    if (extra) discard(extra.path);
    throw err;
  }
  const capturedAt = new Date().toISOString();
  const failure = statusFailure(`page ${redactUrlSecrets(url)}`, pageStatus, config.expect);

  return {
    failure,
    pageStatus,
    path: shotPath,
    mimeType: "image/png",
    sizeBytes,
    capturedAt,
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
    // Playwright records under a random name in the scratch folder: move it out, don't copy.
    renameSync(raw, dest);
    const sizeBytes = statSync(dest).size;
    if (sizeBytes === 0) {
      discard(dest);
      return undefined;
    }
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
): Promise<Captured> {
  const url = String(renderDeep(config.url, scope));
  const timeoutMs = config.timeout ? parseDuration(config.timeout) : 30_000;
  const durationMs = config.duration ? parseDuration(config.duration) : 5_000;
  const viewport = config.viewport ?? { width: 1280, height: 720 };

  const pw = await importPlaywright(ctx.workspace);
  ctx.signal?.throwIfAborted();
  const dir = ensureArtifactDir(ctx, nodeId);
  const slug = slugify(label ?? "video");

  const browser = await launchCaptureBrowser(pw, ctx.signal);
  const onAbort = closeOnAbort(ctx.signal);
  onAbort.add(() => browser.close());
  let videoPath: string | undefined;
  let pageStatus: number | undefined;
  let scratch: string | undefined;
  try {
    scratch = mkdtempSync(join(dir, ".recording-"));
    const folder = scratch;
    onAbort.now(() => rmSync(folder, { recursive: true, force: true }));
    const context = await browser.newContext({
      viewport,
      recordVideo: { dir: scratch, size: viewport },
    });
    onAbort.add(() => context.close());
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
    onAbort.dispose();
    await browser.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }

  if (ctx.signal?.aborted) {
    // Cancelled while the browser was closing: the run is over, so keep nothing of it.
    if (videoPath) discard(videoPath);
    ctx.signal.throwIfAborted();
  }
  if (!videoPath || !existsSync(videoPath)) {
    throw new Error("demo video: Playwright did not produce a recording");
  }
  const failure = statusFailure(`page ${redactUrlSecrets(url)}`, pageStatus, config.expect);
  return {
    failure,
    pageStatus,
    path: videoPath,
    mimeType: "video/webm",
    sizeBytes: statSync(videoPath).size,
    capturedAt: new Date().toISOString(),
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
): Captured {
  ctx.signal?.throwIfAborted();
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

  const dir = ensureArtifactDir(ctx, nodeId);
  const ext = extname(source) || "";
  const base = basename(source, ext);
  const dest = join(dir, `${timestampSlug()}-${slugify(label ?? base)}${ext}`);
  copyFileSync(source, dest);
  let sizeBytes: number;
  try {
    sizeBytes = assertNotEmpty(dest, "demo file");
  } catch (err) {
    discard(dest);
    throw err;
  }

  return { path: dest, mimeType: mimeForPath(dest), sizeBytes, capturedAt: new Date().toISOString() };
}

/** `ok` follows from `status` and nothing else. */
function okFor(status: DemoStatus): boolean {
  return status === "passed" || status === "inconclusive";
}

/**
 * A capture that worked: `failed` when it recorded a failure, else `inconclusive`,
 * because these modes check nothing that could show an objective was met. Throws
 * when a kept file cannot be described, which makes the capture `not_captured`.
 */
async function toResult(
  ctx: NodeRunContext,
  kind: DemoKind,
  label: string | undefined,
  c: Captured,
): Promise<DemoResult> {
  const status: DemoStatus = c.failure ? "failed" : "inconclusive";
  const artifacts = await Promise.all(
    [{ path: c.path, mimeType: c.mimeType }, ...(c.extra ?? [])].map((f) =>
      describeArtifactFile(ctx.workspace, f.path, { mimeType: f.mimeType }),
    ),
  );
  return {
    ok: okFor(status),
    status,
    kind,
    path: c.path,
    mimeType: c.mimeType,
    sizeBytes: c.sizeBytes,
    reason: c.failure ?? null,
    capturedAt: c.capturedAt,
    label: label ?? null,
    extra: c.extra && c.extra.length > 0 ? c.extra : null,
    pageStatus: c.pageStatus ?? null,
    request: c.request ?? null,
    response: c.response ?? null,
    artifacts,
  };
}

/** Nothing was captured: no file, so every field that describes one is `null`. */
function failureResult(kind: DemoKind, reason: string, label?: string): DemoResult {
  return {
    ok: false,
    status: "not_captured",
    kind,
    path: null,
    mimeType: null,
    sizeBytes: null,
    reason,
    capturedAt: new Date().toISOString(),
    label: label ?? null,
    extra: null,
    pageStatus: null,
    request: null,
    response: null,
    artifacts: [],
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
      status: result.status,
      kind: result.kind,
      nodeId,
      capturedAt: result.capturedAt,
      ...(result.path ? { path: result.path } : {}),
      ...(result.mimeType ? { mimeType: result.mimeType } : {}),
      ...(result.sizeBytes != null ? { sizeBytes: result.sizeBytes } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.label ? { label: result.label } : {}),
      ...(result.extra && result.extra.length > 0 ? { extra: result.extra } : {}),
      ...(result.artifacts.length > 0 ? { artifacts: result.artifacts } : {}),
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

        // A run cancelled before the capture starts touches nothing: no folder, no
        // issue, no manifest entry.
        ctx.signal?.throwIfAborted();

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
          if (strict) throw new Error(result.reason ?? undefined);
          ctx.emit("node.output", result);
          return {
            update: applyOutput(config.output, result, { nodeId, scope }),
          };
        }

        let result: DemoResult;
        let cause: unknown;
        try {
          if (kind === "http" && config.http) {
            result = await toResult(
              ctx,
              kind,
              label,
              await captureHttp(config.http, scope, ctx, nodeId, label, usedSecrets),
            );
          } else if (kind === "screenshot" && config.screenshot) {
            result = await toResult(ctx, kind, label, await captureScreenshot(config.screenshot, scope, ctx, nodeId, label));
          } else if (kind === "video" && config.video) {
            result = await toResult(ctx, kind, label, await captureVideo(config.video, scope, ctx, nodeId, label));
          } else if (kind === "simulator" && config.simulator) {
            const dir = ensureArtifactDir(ctx, nodeId);
            const slug = `${timestampSlug()}-${slugify(label ?? "simulator")}`;
            const sim = await captureSimulator(renderDeep(config.simulator, scope) as SimulatorConfig, {
              artifactDir: dir,
              fileSlug: slug,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            result = await toResult(ctx, kind, label, {
              path: sim.path,
              mimeType: sim.mimeType,
              sizeBytes: sim.sizeBytes,
              capturedAt: new Date().toISOString(),
            });
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
            result = await toResult(ctx, kind, label, captureFile(config.file!, state, scope, ctx, nodeId, label));
          }
        } catch (err) {
          // Cancelling is not a failed capture: no result, no issue, no manifest entry, and
          // `strict` has nothing to turn into an error. The run reports itself as aborted.
          if (ctx.signal?.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : err;
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
        if (!cause && result.status === "failed") {
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
        if (strict && !result.ok) throw new Error(result.reason ?? undefined, { cause });
        ctx.emit("node.output", result);
        return {
          update: applyOutput(config.output, result, { nodeId, scope }),
        };
      },
    };
  },
});
