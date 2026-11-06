/**
 * Loading the optional `playwright` peer for the `demo` node, and telling a
 * missing package apart from a missing browser. Shared with graph preflight.
 */

import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const BROWSER_INSTALL_COMMAND = "npx playwright install chromium ffmpeg";

/** How captures launch, shared with preflight so the two check the same browser. */
export const CAPTURE_BROWSER = { headless: true } as const;

const PREFLIGHT_LAUNCH_MS = 30_000;

export type PlaywrightResponse = { status: () => number };

export type PlaywrightPage = {
  goto: (url: string, opts?: Record<string, unknown>) => Promise<PlaywrightResponse | null>;
  waitForSelector: (sel: string, opts?: Record<string, unknown>) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
  screenshot: (opts?: Record<string, unknown>) => Promise<Buffer>;
  mouse: { wheel: (x: number, y: number) => Promise<void> };
  evaluate: (fn: string | ((...args: unknown[]) => unknown), ...args: unknown[]) => Promise<unknown>;
  video: () => { path: () => Promise<string> } | null;
};

export type PlaywrightModule = {
  chromium: {
    launch: (opts?: Record<string, unknown>) => Promise<{
      newContext: (opts?: Record<string, unknown>) => Promise<{
        newPage: () => Promise<PlaywrightPage>;
        close: () => Promise<void>;
      }>;
      close: () => Promise<void>;
    }>;
  };
};

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

/** The CommonJS entry can expose its API only on `default`, depending on the version. */
function unwrap(ns: unknown): PlaywrightModule {
  const mod = ns as PlaywrightModule & { default?: PlaywrightModule };
  return mod.chromium ? mod : (mod.default ?? mod);
}

export async function importPlaywright(cwd: string): Promise<PlaywrightModule> {
  try {
    const req = createRequire(join(cwd, "package.json"));
    const resolved = req.resolve("playwright");
    return unwrap(await import(pathToFileURL(resolved).href));
  } catch {
    // continue to bare import
  }
  try {
    return unwrap(await import("playwright"));
  } catch (err) {
    if (isMissingModuleError(err)) {
      throw new Error(
        `playwright is not installed. Run \`npm install playwright\` (or \`pnpm add playwright\`) in the graph workspace, then \`${BROWSER_INSTALL_COMMAND}\`.`,
        { cause: err },
      );
    }
    throw err;
  }
}

/** Playwright reports a missing Chromium or ffmpeg download as a missing executable. */
export function isMissingBrowserError(err: unknown): boolean {
  return /Executable doesn't exist/i.test(errMessage(err));
}

export function missingBrowserMessage(): string {
  return `Playwright's browser is not installed. Run \`${BROWSER_INSTALL_COMMAND}\` in the graph workspace.`;
}

/**
 * Why a capture could not start, or undefined when it can. Starts the browser the
 * capture uses and closes it, because `chromium.executablePath()` names full Chrome
 * while headless launches run a separate download. Recording also needs ffmpeg,
 * which Playwright only looks for when a page opens with video on.
 */
export async function playwrightProblem(
  cwd: string,
  opts: { video?: boolean } = {},
): Promise<string | undefined> {
  let pw: PlaywrightModule;
  try {
    pw = await importPlaywright(cwd);
  } catch (err) {
    return errMessage(err);
  }
  let videoDir: string | undefined;
  try {
    const browser = await pw.chromium.launch({ ...CAPTURE_BROWSER, timeout: PREFLIGHT_LAUNCH_MS });
    try {
      if (opts.video) {
        videoDir = await mkdtemp(join(tmpdir(), "flowgraph-preflight-"));
        const context = await browser.newContext({ recordVideo: { dir: videoDir } });
        await context.newPage();
        await context.close();
      }
    } finally {
      await browser.close().catch(() => {});
    }
    return undefined;
  } catch (err) {
    if (isMissingBrowserError(err)) return missingBrowserMessage();
    return `Playwright's browser could not start: ${errMessage(err).split("\n")[0]}`;
  } finally {
    if (videoDir) await rm(videoDir, { recursive: true, force: true }).catch(() => {});
  }
}
