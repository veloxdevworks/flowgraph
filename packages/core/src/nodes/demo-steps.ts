/**
 * Scripted browser flows for the `demo` node (ADR-0019 §1-4): open a page, run the steps,
 * check the assertions. The harness chooses the evidence: the flow is always recorded from
 * the first navigation and always ends with a screenshot, on failure as well.
 *
 * A step that does not hold stops the flow and is the result: the target was reached and did
 * not do what was claimed. Not reaching the target, or losing the browser, throws instead, and
 * the caller reports that nothing was captured.
 */

import { existsSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DemoStep } from "@flowgraph/spec";
import { parseDuration } from "../runtime/duration.js";
import {
  RECORDER_CATCH_UP_MS,
  closeOnAbort,
  isDurationText,
  launchCaptureBrowser,
  statusFailure,
  type PlaywrightBrowser,
  type PlaywrightLocator,
  type PlaywrightModule,
  type PlaywrightPage,
} from "./demo-playwright.js";

const DEFAULT_FLOW_TIMEOUT = "2m";
const DEFAULT_STEP_MS = 30_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const MAX_CONSOLE_MESSAGES = 20;

/** A flow with every template rendered. */
export type RenderedFlow = {
  url: string;
  viewport?: { width: number; height: number } | undefined;
  expect?: { status: number[] } | undefined;
  timeout?: string | undefined;
  stepTimeout?: string | undefined;
  steps: DemoStep[];
  noConsoleErrors: boolean;
};

export type FlowStepRecord = {
  index: number;
  action: string;
  detail: string;
  ok: boolean;
  ms: number;
  error?: string;
};

export type FlowAssertion = { check: string; positive: boolean; held: boolean; observed?: string };

export type FlowConsole = { errors: number; messages: string[] };

export type FlowOutcome = {
  /** Why the flow did not hold, or undefined when every step and assertion did. */
  failure: string | undefined;
  steps: FlowStepRecord[];
  assertions: FlowAssertion[];
  console: FlowConsole;
  pageStatus: number | undefined;
  /** The screenshot of the end state, or of the point of failure. */
  finalScreenshot: string | undefined;
  namedScreenshots: string[];
  video: string | undefined;
  /** Evidence that went missing without changing what the flow showed. */
  warnings: string[];
};

export type FlowOptions = {
  artifactDir: string;
  /** Prefix of every file this flow keeps. */
  fileSlug: string;
  signal?: AbortSignal | undefined;
  /** Applied to every string a result records, because any of them can quote a secret. */
  redact: (text: string) => string;
  /** `redact`, plus credentials in a URL's query or user info. Only for text that is a URL. */
  redactUrl: (url: string) => string;
  /** Whether a value contains a secret. Such a value is never recorded, not even masked in part. */
  holdsSecret: (text: string) => boolean;
  /** Turns a screenshot name into text that is safe in a file name. */
  slugify: (text: string) => string;
};

/** Thrown inside a step for a check that did not hold, to tell it from a Playwright failure. */
class AssertionFailed extends Error {}

/** The first line of a Playwright error, which is its message; later lines are a call log. */
function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-control-regex
  return (text.split("\n")[0] ?? "").replace(/\u001b\[[0-9;]*m/g, "").trim();
}

/**
 * Whether the browser is gone, from its state and Playwright's error type. Never from the wording
 * of the message, which quotes the step's selector or address: a link called "crashed" is no crash.
 */
function isBrowserGone(err: unknown, page: PlaywrightPage, browser: PlaywrightBrowser): boolean {
  return (err as Error | undefined)?.name === "TargetClosedError" || page.isClosed() || !browser.isConnected();
}

/**
 * Text as a case-sensitive substring, with spaces matching as the page lays them out. Playwright's
 * default ignores case, so `Saved` would hold on "Not saved".
 */
function textPattern(text: string): RegExp {
  const words = text.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(words.join("\\s+"));
}

/** Steps never run code in the page, and a `javascript:` address would. */
function assertNavigable(url: string): void {
  if (/^\s*javascript:/i.test(url)) throw new Error("javascript: addresses are not allowed");
}

/** What a step did, safe to record. */
function describeStep(step: DemoStep, opts: FlowOptions): { action: string; detail: string } {
  const { redact, redactUrl, holdsSecret } = opts;
  if ("goto" in step) return { action: "goto", detail: redactUrl(step.goto) };
  if ("click" in step) return { action: "click", detail: redact(step.click) };
  if ("fill" in step) {
    // Masked in two parts: "#password = x" as one string reads as a credential, selector included.
    const value = holdsSecret(step.fill.value) ? "[REDACTED]" : redact(step.fill.value);
    return { action: "fill", detail: `${redact(step.fill.selector)} = ${value}` };
  }
  if ("press" in step) return { action: "press", detail: redact(step.press) };
  if ("wait" in step) return { action: "wait", detail: redact(step.wait) };
  if ("screenshot" in step) return { action: "screenshot", detail: redact(step.screenshot) };
  return { action: "expect", detail: redact(describeCheck(step.expect)) };
}

function describeCheck(check: Extract<DemoStep, { expect: unknown }>["expect"]): string {
  if ("text" in check) return `text: ${check.text}`;
  if ("visible" in check) return `visible: ${check.visible}`;
  if ("url" in check) return `url: ${check.url}`;
  return `hidden: ${check.hidden}`;
}

/** Any match that is visible counts, so an earlier hidden copy of the text does not fail it. */
function visibleOf(locator: PlaywrightLocator): PlaywrightLocator {
  return locator.filter({ visible: true }).first();
}

/** Check one assertion, recording the literal check and what was found. */
async function runCheck(
  page: PlaywrightPage,
  check: Extract<DemoStep, { expect: unknown }>["expect"],
  timeout: number,
  assertions: FlowAssertion[],
  redact: (text: string) => string,
  redactUrl: (url: string) => string,
  browser: PlaywrightBrowser,
): Promise<void> {
  const label = redact(describeCheck(check));
  const positive = !("hidden" in check);
  try {
    if ("text" in check) await visibleOf(page.getByText(textPattern(check.text))).waitFor({ state: "visible", timeout });
    else if ("visible" in check) await visibleOf(page.locator(check.visible)).waitFor({ state: "visible", timeout });
    else if ("url" in check) await page.waitForURL(check.url, { timeout, waitUntil: "commit" });
    else await visibleOf(page.locator(check.hidden)).waitFor({ state: "hidden", timeout });
  } catch (err) {
    if (isBrowserGone(err, page, browser)) throw err;
    const at = redactUrl(page.url());
    const observed =
      "url" in check
        ? `the page is at ${at}`
        : "hidden" in check
          ? `still visible on ${at}`
          : `not visible on ${at}`;
    assertions.push({ check: label, positive, held: false, observed });
    throw new AssertionFailed(`${label} did not hold: ${observed}`);
  }
  assertions.push({ check: label, positive, held: true });
}

/**
 * Run a flow in a real browser. Throws when the target cannot be reached or the browser is
 * lost, and on abort, leaving no files behind in those cases.
 */
export async function runFlow(pw: PlaywrightModule, flow: RenderedFlow, opts: FlowOptions): Promise<FlowOutcome> {
  const { signal, redact, redactUrl } = opts;
  assertNavigable(flow.url);
  const flowTimeout = flow.timeout ?? DEFAULT_FLOW_TIMEOUT;
  const stepMs = flow.stepTimeout ? parseDuration(flow.stepTimeout) : DEFAULT_STEP_MS;
  const deadline = Date.now() + parseDuration(flowTimeout);
  const pastLimit = (): Error => new Error(`the flow ran past its ${flowTimeout} limit`);
  const remaining = (): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw pastLimit();
    return left;
  };
  const stepBudget = (): number => Math.min(stepMs, remaining());

  const out: FlowOutcome = {
    failure: undefined,
    steps: [],
    assertions: [],
    console: { errors: 0, messages: [] },
    pageStatus: undefined,
    finalScreenshot: undefined,
    namedScreenshots: [],
    video: undefined,
    warnings: [],
  };
  const noteConsoleError = (text: string): void => {
    out.console.errors++;
    if (out.console.messages.length < MAX_CONSOLE_MESSAGES) out.console.messages.push(redact(text));
  };

  const browser = await launchCaptureBrowser(pw, signal);
  const onAbort = closeOnAbort(signal);
  onAbort.add(() => browser.close());
  let scratch: string | undefined;
  try {
    // Files stay in a scratch folder until the flow ends, so a run that captures nothing, or is
    // cancelled, leaves nothing that looks like evidence.
    scratch = mkdtempSync(join(opts.artifactDir, ".recording-"));
    const folder = scratch;
    onAbort.now(() => rmSync(folder, { recursive: true, force: true }));

    const viewport = flow.viewport ?? DEFAULT_VIEWPORT;
    const context = await browser.newContext({ viewport, recordVideo: { dir: scratch, size: viewport } });
    onAbort.add(() => context.close());
    const page = await context.newPage();
    const videoHandle = page.video();
    let crashed = false;
    page.on("crash", () => {
      crashed = true;
    });
    page.on("console", (message) => {
      const m = message as { type: () => string; text: () => string };
      if (m.type() === "error") noteConsoleError(m.text());
    });
    page.on("pageerror", (error) => noteConsoleError(firstLine(error)));

    // A page reached by a click has a status too, and `expect: { url }` holds on an error page.
    // Unlike the first page, a later one is only held to the rule for errors: `expect.status`
    // lists the errors that are allowed, not the only statuses that may ever appear.
    const refusedStatus = (url: string, status: number | undefined): string | undefined =>
      status !== undefined && status >= 400 && !flow.expect?.status.includes(status)
        ? `page ${redactUrl(url)} returned HTTP ${status}`
        : undefined;
    let navigationFailure: string | undefined;
    page.on("response", (response) => {
      const r = response as {
        status: () => number;
        url: () => string;
        frame: () => unknown;
        request: () => { isNavigationRequest: () => boolean };
      };
      // A request for a page that never gets a frame, such as a download, has no frame to ask about.
      try {
        if (!r.request().isNavigationRequest() || r.frame() !== page.mainFrame()) return;
      } catch {
        return;
      }
      navigationFailure ??= refusedStatus(r.url(), r.status());
    });

    const shoot = async (path: string, timeout: number): Promise<void> => {
      await page.screenshot({ path, fullPage: true, timeout });
      if (statSync(path).size === 0) throw new Error("the screenshot came out empty");
    };

    const navigate = async (url: string): Promise<number | undefined> => {
      assertNavigable(url);
      const response = await page.goto(url, { waitUntil: "load", timeout: stepBudget() });
      return response ? response.status() : undefined;
    };

    const runStep = async (step: DemoStep, index: number): Promise<void> => {
      if ("goto" in step) {
        const failure = refusedStatus(step.goto, await navigate(step.goto));
        if (failure) throw new AssertionFailed(failure);
      } else if ("click" in step) {
        await page.locator(step.click).click({ timeout: stepBudget() });
      } else if ("fill" in step) {
        await page.locator(step.fill.selector).fill(step.fill.value, { timeout: stepBudget() });
      } else if ("press" in step) {
        remaining();
        await page.keyboard.press(step.press);
      } else if ("wait" in step) {
        if (isDurationText(step.wait)) {
          const wanted = parseDuration(step.wait);
          const left = remaining();
          await page.waitForTimeout(Math.min(wanted, left));
          if (wanted > left) throw pastLimit();
        } else {
          await page.waitForSelector(step.wait, { timeout: stepBudget() });
        }
      } else if ("screenshot" in step) {
        const name = opts.slugify(redact(step.screenshot));
        const file = `${opts.fileSlug}-${String(index).padStart(2, "0")}-${name}.png`;
        const path = join(folder, file);
        await shoot(path, stepBudget());
        out.namedScreenshots.push(path);
      } else {
        await runCheck(page, step.expect, stepBudget(), out.assertions, redact, redactUrl, browser);
      }
    };

    const browserLost = (err: unknown): Error =>
      new Error(`the browser was lost during the flow: ${redact(firstLine(err))}`);

    /** Let what a step changed reach the recording, so a reviewer can follow the flow. */
    const changesThePage = (step: DemoStep): boolean =>
      "goto" in step || "click" in step || "fill" in step || "press" in step;

    /** Run one step and record it. Returns false when the flow should stop. */
    const record = async (
      index: number,
      action: string,
      detail: string,
      run: () => Promise<void>,
    ): Promise<boolean> => {
      const started = Date.now();
      const entry: FlowStepRecord = { index, action, detail, ok: true, ms: 0 };
      out.steps.push(entry);
      try {
        await run();
        if (navigationFailure) throw new AssertionFailed(navigationFailure);
        entry.ms = Date.now() - started;
        return true;
      } catch (err) {
        signal?.throwIfAborted();
        if (crashed || isBrowserGone(err, page, browser)) throw browserLost(err);
        entry.ms = Date.now() - started;
        entry.ok = false;
        entry.error = redact(firstLine(err));
        out.failure = err instanceof AssertionFailed ? entry.error : `step ${index} (${action} ${entry.detail}): ${entry.error}`;
        return false;
      }
    };

    try {
      // Not reaching the target at all means nothing was captured, so this one throws.
      let opened: number | undefined;
      const openedAt = Date.now();
      try {
        opened = await navigate(flow.url);
      } catch (err) {
        signal?.throwIfAborted();
        // No `cause`: Playwright's own error can quote a secret, and hosts log causes.
        throw new Error(`could not open ${redactUrl(flow.url)}: ${redact(firstLine(err))}`);
      }
      out.pageStatus = opened;
      const openFailure = statusFailure(`page ${redactUrl(flow.url)}`, opened, flow.expect);
      const openEntry: FlowStepRecord = {
        index: 0,
        action: "open",
        detail: redactUrl(flow.url),
        ok: !openFailure,
        ms: Date.now() - openedAt,
      };
      if (openFailure) {
        openEntry.error = openFailure;
        out.failure = openFailure;
      }
      out.steps.push(openEntry);

      if (!out.failure) {
        await page.waitForTimeout(RECORDER_CATCH_UP_MS);
        for (const [i, step] of flow.steps.entries()) {
          const { action, detail } = describeStep(step, opts);
          if (!(await record(i + 1, action, detail, () => runStep(step, i + 1)))) break;
          if (changesThePage(step)) await page.waitForTimeout(RECORDER_CATCH_UP_MS);
        }
      }

      // The screenshot of the end state, or of the point of failure, whatever the flow's author
      // asked for. It has its own time, because a flow that ran out of time needs it most.
      const finalPath = join(folder, `${opts.fileSlug}-final.png`);
      try {
        await shoot(finalPath, stepMs);
        out.finalScreenshot = finalPath;
      } catch (err) {
        signal?.throwIfAborted();
        if (crashed || isBrowserGone(err, page, browser)) throw browserLost(err);
        out.warnings.push(`the final screenshot could not be saved: ${redact(firstLine(err))}`);
      }
      await page.waitForTimeout(RECORDER_CATCH_UP_MS);

      // Last, because these cover the whole flow and the page can still act after the last step.
      if (!out.failure && navigationFailure) out.failure = navigationFailure;
      if (!out.failure && flow.noConsoleErrors) {
        const held = out.console.errors === 0;
        const observed = held ? undefined : `${out.console.errors} error(s), first: ${out.console.messages[0]}`;
        out.assertions.push({
          check: "noConsoleErrors",
          positive: false,
          held,
          ...(observed ? { observed } : {}),
        });
        if (observed) out.failure = `noConsoleErrors did not hold: ${observed}`;
      }
    } finally {
      await context.close().catch((err: unknown) => {
        out.warnings.push(`the browser did not close cleanly: ${redact(firstLine(err))}`);
      });
    }

    signal?.throwIfAborted();
    const raw = await videoHandle?.path().catch(() => undefined);
    if (raw && existsSync(raw) && statSync(raw).size > 0) {
      out.video = join(folder, `${opts.fileSlug}-recording.webm`);
      renameSync(raw, out.video);
    } else {
      out.warnings.push("the flow's recording was not saved");
    }

    // Nothing above can fail now: move the evidence out of the scratch folder.
    const keep = (path: string): string => {
      const dest = join(opts.artifactDir, path.slice(folder.length + 1));
      renameSync(path, dest);
      return dest;
    };
    out.namedScreenshots = out.namedScreenshots.map(keep);
    if (out.finalScreenshot) out.finalScreenshot = keep(out.finalScreenshot);
    if (out.video) out.video = keep(out.video);
    return out;
  } finally {
    onAbort.dispose();
    await browser.close().catch(() => {});
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
