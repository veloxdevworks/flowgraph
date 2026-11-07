/**
 * What a `demo` capture reports: `ok` must mean the capture worked AND recorded
 * no failure. Uses a real local HTTP server, plus stand-ins for Playwright (found
 * through the workspace's node_modules) and for xcrun / adb (found through PATH).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DemoWithSchema, type GraphSpec } from "@flowgraph/spec";
import type { NodeRunContext } from "../context.js";
import { preflightGraphRequires } from "../preflight-graph.js";
import { compileGraph } from "../compiler.js";
import type { FlowgraphEvent } from "../events.js";
import { demoNode, type DemoResult } from "./demo.js";
import { readDemoManifest } from "./demo-manifest.js";
import { launchCaptureBrowser } from "./demo-playwright.js";

const THREAD = "capture-thread";
const NODE = "capture";

function mkdir(prefix = "fg-demo-capture-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function capture(
  workspace: string,
  withConfig: Record<string, unknown>,
  opts: {
    state?: Record<string, unknown>;
    input?: Record<string, unknown>;
    signal?: AbortSignal;
    /** Filled as the node raises issues, so a run that throws can still be inspected. */
    issues?: Array<Record<string, unknown>>;
  } = {},
) {
  const issues = opts.issues ?? [];
  const config = DemoWithSchema.parse(withConfig);
  const compiled = demoNode.build({ graphName: "g" }, { id: NODE }, config as never);
  const ctx = {
    nodeId: NODE,
    nodeType: "demo",
    attempt: 1,
    workspace,
    meta: { runId: "run", threadId: THREAD, startedAt: new Date().toISOString(), graph: "g" },
    config: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    emit() {},
    issue: (issue: Record<string, unknown>) => issues.push(issue),
    _input: opts.input ?? {},
    ...(opts.signal ? { signal: opts.signal } : {}),
  } as unknown as NodeRunContext;
  const res = await compiled.run(opts.state ?? {}, ctx);
  const { update } = res as unknown as { update: { outputs: Record<string, DemoResult> } };
  return { out: update.outputs[NODE]!, issues };
}

describe("http capture", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/hang") {
        setTimeout(() => res.end("late"), 1_500).unref();
        return;
      }
      if (url.pathname === "/echo-auth") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ seen: req.headers["x-custom"] }));
        return;
      }
      if (url.pathname === "/private") {
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "session=COOKIEVALUE" });
        res.end(JSON.stringify({ name: "ada", apiKey: "BODYKEYVALUE", nested: { password: "BODYPASSVALUE" } }));
        return;
      }
      res.writeHead(Number(url.searchParams.get("status") ?? 200), { "content-type": "text/plain" });
      res.end("body");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("reports a 500 as a failure and keeps the transcript as evidence", async () => {
    const workspace = mkdir();
    const { out, issues } = await capture(workspace, { http: { url: `${base}/?status=500` } });

    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/returned HTTP 500/);
    expect(out.response?.status).toBe(500);
    expect(fs.existsSync(out.path!)).toBe(true);
    expect(issues[0]).toMatchObject({ code: "CAPTURE_FAILED", severity: "warning" });
    expect(readDemoManifest(workspace, THREAD)[0]).toMatchObject({ ok: false, path: out.path });
  });

  it("lets a graph declare which statuses count as success", async () => {
    const expected = await capture(mkdir(), { http: { url: `${base}/?status=404`, expect: { status: [404] } } });
    expect(expected.out.ok).toBe(true);
    expect(expected.issues).toHaveLength(0);

    const other = await capture(mkdir(), { http: { url: `${base}/?status=201`, expect: { status: [200] } } });
    expect(other.out.ok).toBe(false);
    expect(other.out.reason).toMatch(/returned HTTP 201, expected 200/);
  });

  it("honors http.timeout", async () => {
    const started = Date.now();
    const { out } = await capture(mkdir(), { http: { url: `${base}/hang`, timeout: "100ms" } });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/did not respond within 100ms/);
  });

  it("masks credentials in the saved transcript and the result", async () => {
    const { out } = await capture(mkdir(), {
      http: { url: `${base}/private?token=URLTOKENVALUE&page=2`, headers: { Authorization: "Bearer HEADERVALUE" } },
    });
    const saved = fs.readFileSync(out.path!, "utf8");

    for (const secret of ["COOKIEVALUE", "BODYKEYVALUE", "BODYPASSVALUE", "URLTOKENVALUE", "HEADERVALUE"]) {
      expect(saved).not.toContain(secret);
      expect(JSON.stringify(out)).not.toContain(secret);
    }
    expect(saved).toContain("page=2");
    expect(saved).toContain("ada");
  });

  it("masks a rendered secret wherever the server echoes it", async () => {
    vi.stubEnv("DEMO_TEST_SECRET", "rendered-secret-value");
    const { out } = await capture(mkdir(), {
      http: { url: `${base}/echo-auth`, headers: { "X-Custom": "{{ secret.DEMO_TEST_SECRET }}" } },
    });

    expect(out.ok).toBe(true);
    expect(fs.readFileSync(out.path!, "utf8")).not.toContain("rendered-secret-value");
  });

  it("strict fails the node on a recorded failure, and the evidence stays in the manifest", async () => {
    const workspace = mkdir();
    await expect(capture(workspace, { strict: true, http: { url: `${base}/?status=503` } })).rejects.toThrow(/HTTP 503/);

    const [entry] = readDemoManifest(workspace, THREAD);
    expect(entry).toMatchObject({ ok: false, kind: "http" });
    expect(fs.existsSync(entry!.path!)).toBe(true);
  });
});

/** A workspace whose `playwright` resolves to a stand-in with the given behavior. */
function fakePlaywrightWorkspace(
  opts: {
    status?: number | null;
    launchError?: string;
    /** Thrown when a page opens with video on, as a missing ffmpeg is. */
    videoError?: string;
    gotoError?: string;
    emptyScreenshot?: boolean;
    emptyVideo?: boolean;
    executablePath?: string;
    /** Expose the API only on `default`, as a CommonJS entry can. */
    defaultOnly?: boolean;
    /** Make one call wait until the context or browser is closed, which then rejects it, as Playwright does. */
    hang?: "goto" | "waitForSelector" | "waitForTimeout" | "screenshot";
    /** How long the browser takes to start. */
    launchMs?: number;
  } = {},
): string {
  const workspace = mkdir();
  const dir = path.join(workspace, "node_modules", "playwright");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "package.json"), "{}");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "playwright", main: "index.mjs" }));
  const status = opts.status === undefined ? 200 : opts.status;
  const api = `{
    executablePath: ${opts.executablePath ? `() => ${JSON.stringify(opts.executablePath)}` : "undefined"},
    launch: async () => {
      log("launch");
      ${opts.launchMs ? `await new Promise((resolve) => setTimeout(resolve, ${opts.launchMs}));` : ""}
      ${opts.launchError ? `throw new Error(${JSON.stringify(opts.launchError)});` : ""}
      let shut;
      const closed = new Promise((_resolve, reject) => {
        shut = () => reject(new Error("Target page, context or browser has been closed"));
      });
      closed.catch(() => {});
      return {
        close: async () => { log("browser.close"); shut(); },
        newContext: async (contextOpts = {}) => {
          const raw = contextOpts.recordVideo ? join(contextOpts.recordVideo.dir, "random-playwright-name.webm") : null;
          return {
            close: async () => {
              log("context.close");
              shut();
              if (raw) writeFileSync(raw, ${opts.emptyVideo ? '""' : '"webm"'});
            },
            newPage: async () => {
              ${opts.videoError ? `if (raw) throw new Error(${JSON.stringify(opts.videoError)});` : ""}
              return {
              goto: async () => {
                ${opts.hang === "goto" ? 'log("hang"); await closed;' : ""}
                ${opts.gotoError ? `throw new Error(${JSON.stringify(opts.gotoError)});` : ""}
                return ${status === null ? "null" : `{ status: () => ${status} }`};
              },
              waitForSelector: async () => { ${opts.hang === "waitForSelector" ? 'log("hang"); await closed;' : ""} },
              waitForTimeout: async () => { ${opts.hang === "waitForTimeout" ? 'log("hang"); await closed;' : ""} },
              evaluate: async () => {},
              mouse: { wheel: async () => {} },
              screenshot: async ({ path }) => {
                ${opts.hang === "screenshot" ? 'log("hang"); await closed;' : ""}
                writeFileSync(path, ${opts.emptyScreenshot ? '""' : '"png"'});
              },
              video: () => (raw ? { path: async () => raw } : null),
              };
            },
          };
        },
      };
    },
  }`;
  fs.writeFileSync(
    path.join(dir, "index.mjs"),
    `import { appendFileSync, writeFileSync } from "node:fs";
     import { join } from "node:path";
     import { fileURLToPath } from "node:url";
     // What the browser was asked to do, for tests to read: <workspace>/playwright.log
     const log = (line) => appendFileSync(fileURLToPath(new URL("../../playwright.log", import.meta.url)), line + "\\n");
     const chromium = ${api};
     ${opts.defaultOnly ? "export default { chromium };" : "export { chromium };"}`,
  );
  return workspace;
}

describe("browser capture", () => {
  it("saves a screenshot and reports the page status", async () => {
    const { out, issues } = await capture(fakePlaywrightWorkspace(), { label: "home", screenshot: { url: "http://app/" } });

    expect(out).toMatchObject({ ok: true, kind: "screenshot", pageStatus: 200, mimeType: "image/png", label: "home" });
    expect(fs.readFileSync(out.path!, "utf8")).toBe("png");
    expect(issues).toHaveLength(0);
  });

  it("accepts Playwright exposed only on the default export", async () => {
    const { out } = await capture(fakePlaywrightWorkspace({ defaultOnly: true }), { screenshot: { url: "http://app/" } });
    expect(out.ok).toBe(true);
  });

  it("reports a screenshot of an error page as a failure and keeps the image", async () => {
    const { out, issues } = await capture(fakePlaywrightWorkspace({ status: 500 }), { screenshot: { url: "http://app/" } });

    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/returned HTTP 500/);
    expect(fs.existsSync(out.path!)).toBe(true);
    expect(issues[0]).toMatchObject({ code: "CAPTURE_FAILED" });
  });

  it("passes a page that was meant to be an error, and one with no HTTP response", async () => {
    const notFound = await capture(fakePlaywrightWorkspace({ status: 404 }), {
      screenshot: { url: "http://app/missing", expect: { status: [404] } },
    });
    expect(notFound.out.ok).toBe(true);

    const noResponse = await capture(fakePlaywrightWorkspace({ status: null }), { screenshot: { url: "about:blank" } });
    expect(noResponse.out.ok).toBe(true);
    expect(noResponse.out.pageStatus).toBeNull();
  });

  it("rejects an empty screenshot", async () => {
    const { out } = await capture(fakePlaywrightWorkspace({ emptyScreenshot: true }), { screenshot: { url: "http://app/" } });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/empty file/);
  });

  it("records a video once, without leaving Playwright's raw file behind", async () => {
    const { out } = await capture(fakePlaywrightWorkspace(), { video: { url: "http://app/", duration: "1ms" } });

    expect(out).toMatchObject({ ok: true, kind: "video", mimeType: "video/webm", pageStatus: 200 });
    const files = fs.readdirSync(path.dirname(out.path!));
    expect(files).toEqual([path.basename(out.path!)]);
  });

  it("keeps a screenshot's extra recording and reports a video of an error page as a failure", async () => {
    const shot = await capture(fakePlaywrightWorkspace(), { screenshot: { url: "http://app/", video: true } });
    expect(shot.out.extra?.[0]).toMatchObject({ kind: "video", mimeType: "video/webm" });
    expect(fs.existsSync(shot.out.extra![0]!.path)).toBe(true);

    const video = await capture(fakePlaywrightWorkspace({ status: 502 }), { video: { url: "http://app/", duration: "1ms" } });
    expect(video.out.ok).toBe(false);
    expect(fs.existsSync(video.out.path!)).toBe(true);
  });

  it("tells a missing browser apart from a missing package", async () => {
    const { out, issues } = await capture(
      fakePlaywrightWorkspace({ launchError: "browserType.launch: Executable doesn't exist at /x/chromium" }),
      { screenshot: { url: "http://app/" } },
    );

    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/browser is not installed/);
    expect(issues[0]).toMatchObject({ code: "TOOL_NOT_FOUND" });
    expect(issues[0]!["remediation"]).toMatch(/playwright install chromium/);
    expect(issues[0]!["remediation"]).not.toMatch(/npm install/);
  });

  it("does not suggest installing anything when the page simply failed to load", async () => {
    const { issues } = await capture(fakePlaywrightWorkspace({ gotoError: "net::ERR_CONNECTION_REFUSED" }), {
      screenshot: { url: "http://app/" },
    });

    expect(issues[0]).toMatchObject({ code: "CAPTURE_FAILED" });
    expect(issues[0]).not.toHaveProperty("remediation");
  });
});

describe("file capture", () => {
  it("attaches a file inside the workspace, by relative or absolute path", async () => {
    const workspace = mkdir();
    const source = path.join(workspace, "report.md");
    fs.writeFileSync(source, "# report");

    expect((await capture(workspace, { file: { path: "./report.md" } })).out.ok).toBe(true);
    expect((await capture(workspace, { file: { path: source } })).out.ok).toBe(true);
  });

  it("refuses a file outside the workspace, directly or through a symlink", async () => {
    const workspace = mkdir();
    const outside = path.join(mkdir(), "private.txt");
    fs.writeFileSync(outside, "private");
    fs.symlinkSync(outside, path.join(workspace, "link.txt"));

    for (const p of [outside, "./link.txt"]) {
      const { out } = await capture(workspace, { file: { path: p } });
      expect(out.ok).toBe(false);
      expect(out.reason).toMatch(/outside the run workspace/);
    }
    expect(fs.existsSync(path.join(workspace, ".flowgraph", "artifacts", THREAD, NODE))).toBe(false);
  });

  it("attaches from a worktree this thread created", async () => {
    const workspace = mkdir();
    const worktree = mkdir();
    const source = path.join(worktree, "built.txt");
    fs.writeFileSync(source, "built");

    const { out } = await capture(
      workspace,
      { file: { path: source } },
      { state: { __worktrees: [{ path: worktree, branch: "b", repo: workspace }] } },
    );
    expect(out.ok).toBe(true);
  });

  it("rejects an empty file", async () => {
    const workspace = mkdir();
    fs.writeFileSync(path.join(workspace, "empty.txt"), "");
    const { out } = await capture(workspace, { file: { path: "./empty.txt" } });
    expect(out.ok).toBe(false);
  });
});

const FAKE_XCRUN = `#!/bin/bash
echo "$*" >> "$FAKE_LOG"
dest="\${@: -1}"
case "$*" in
  *"--find simctl"*) [ "$FAKE_NO_SIMCTL" = 1 ] && exit 1; exit 0 ;;
  *"simctl bootstatus"*) [ "$FAKE_BOOT_HANG" = 1 ] && { echo $$ >> "$FAKE_LOG.pids"; exec sleep 30; }; [ "$FAKE_BOOT_EXIT" != "" ] && { echo "bad device" >&2; exit "$FAKE_BOOT_EXIT"; }; exit 0 ;;
  *"simctl launch"*) [ "$FAKE_LAUNCH_EXIT" != "" ] && { echo "app not installed" >&2; exit "$FAKE_LAUNCH_EXIT"; }; touch "$FAKE_LOG.opened"; exit 0 ;;
  *"simctl openurl"*) [ "$FAKE_OPENURL_EXIT" != "" ] && { echo "no handler" >&2; exit "$FAKE_OPENURL_EXIT"; }; touch "$FAKE_LOG.opened"; exit 0 ;;
  *screenshot*)
    # The simulator service writes the picture itself: it can land after the client was killed.
    [ "$FAKE_SHOT_LATE" = 1 ] && { ( sleep 1; printf png > "$dest" ) >/dev/null 2>&1 & echo $$ >> "$FAKE_LOG.pids"; exec sleep 30; }
    case "$FAKE_SCREEN" in
      frozen) printf 'home' > "$dest" ;;
      spinner) date +%s%N > "$dest" ;;
      *) if [ -e "$FAKE_LOG.opened" ]; then printf 'app' > "$dest"; else printf 'home' > "$dest"; fi ;;
    esac
    exit 0 ;;
  *recordVideo*)
    echo $$ >> "$FAKE_LOG.pids"
    case "$FAKE_RECORD" in
      fail) printf 'partial' > "$dest"; echo "record broke" >&2; exit 1 ;;
      empty) trap ': > "$dest"; kill $pid; exit 0' INT ;;
      slowstop) trap 'touch "$FAKE_LOG.stopping"; sleep 1.5; printf mp4 > "$dest"; kill $pid; exit 0' INT ;;
      *) trap 'printf mp4 > "$dest"; kill $pid; exit 0' INT ;;
    esac
    sleep 5 >/dev/null 2>&1 &
    pid=$!
    wait $pid
    exit 0 ;;
esac
`;

const FAKE_ADB = `#!/bin/bash
echo "$*" >> "$FAKE_LOG"
dest="\${@: -1}"
# A recorder on the device outlives the adb client that started it: FAKE_DEVICE_RECORDER=1
# keeps that state in files, which only a kill from the device side clears.
device_recording="$FAKE_LOG.device-recording"
case "$*" in
  *"shell pidof screenrecord"*) [ -e "$device_recording" ] && echo 4242; exit 0 ;;
  *"shell kill "*) [ -e "$device_recording" ] && rm -f "$device_recording"; exit 0 ;;
  *"shell rm -f "*) rm -f "$FAKE_LOG.device-file"; exit 0 ;;
  *"shell screenrecord"*)
    if [ "$FAKE_DEVICE_RECORDER" = 1 ]; then
      echo $$ >> "$FAKE_LOG.pids"
      trap 'kill $pid; exit 0' INT
      sleep 30 >/dev/null 2>&1 &
      pid=$!
      # Tests cancel as soon as the recorder file appears. Shell builtins, after the trap: bash
      # drops a SIGINT that arrives while a foreground child such as touch is running.
      : > "$FAKE_LOG.device-file"
      : > "$device_recording"
      wait $pid
      exit 0
    fi
    exit 0 ;;
esac
case "$*" in
  *"exec-out screencap"*)
    # A raw frame: a 16-byte header, then 10,000 4-byte pixels.
    fill() { head -c 40016 /dev/zero | tr '\\0' "$1"; }
    case "$FAKE_SCREEN" in
      frozen) fill h ;;
      spinner) head -c 40016 /dev/urandom ;;
      flicker) if [ -e "$FAKE_LOG.opened" ]; then fill a | head -c 40012; head -c 4 /dev/urandom; else fill h; fi ;;
      *) if [ -e "$FAKE_LOG.opened" ]; then fill a; else fill h; fi ;;
    esac
    exit 0 ;;
  *monkey*) [ "$FAKE_MONKEY" = none ] && { echo "args: [-p, x]"; echo "** No activities found to run, monkey aborted."; exit 252; }; touch "$FAKE_LOG.opened"; exit 0 ;;
  *"am start"*) [ "$FAKE_AM" = error ] && { echo "Starting: Intent { }"; echo "Error: Activity not started, unable to resolve Intent"; exit 0; }; touch "$FAKE_LOG.opened"; exit 0 ;;
  *screencap*) [ "$FAKE_SCREENCAP_HANG" = 1 ] && { echo $$ >> "$FAKE_LOG.pids"; exec sleep 30; }; [ "$FAKE_SCREENCAP_EXIT" != "" ] && { echo "no device" >&2; exit "$FAKE_SCREENCAP_EXIT"; }; exit 0 ;;
  *screenrecord*) exit 0 ;;
  *pull*) printf 'data' > "$dest"; exit 0 ;;
esac
exit 0
`;

describe.skipIf(process.platform === "win32")("simulator capture", () => {
  let log: string;
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);

  function stubTools(env: Record<string, string> = {}): void {
    const bin = mkdir("fg-demo-bin-");
    fs.writeFileSync(path.join(bin, "xcrun"), FAKE_XCRUN, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "adb"), FAKE_ADB, { mode: 0o755 });
    log = path.join(bin, "calls.log");
    vi.stubEnv("PATH", `${bin}:${process.env["PATH"]}`);
    vi.stubEnv("FAKE_LOG", log);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  }

  afterEach(() => vi.unstubAllEnvs());

  const ios = (extra: Record<string, unknown> = {}) => ({
    simulator: { platform: "ios", capture: "screenshot", ...extra },
  });
  const android = (extra: Record<string, unknown> = {}) => ({
    simulator: { platform: "android", capture: "screenshot", ...extra },
  });

  it("renders templates in every field, and boots with a check", async () => {
    stubTools();
    const { out } = await capture(
      mkdir(),
      ios({ device: "{{ state.device }}", app: "{{ input.bundle }}", deepLink: "myapp://item/{{ state.id }}", settle: "1ms" }),
      { state: { device: "iPhone 15", id: 42 }, input: { bundle: "com.real.app" } },
    );

    expect(out).toMatchObject({ ok: true, kind: "simulator", mimeType: "image/png" });
    expect(calls()).toEqual(
      expect.arrayContaining([
        "simctl bootstatus iPhone 15 -b",
        "simctl launch iPhone 15 com.real.app",
        "simctl openurl iPhone 15 myapp://item/42",
      ]),
    );
  });

  it("reports a capture that worked as inconclusive and a launch that failed as not_captured", async () => {
    stubTools();
    const shot = await capture(mkdir(), ios({ settle: "1ms" }));
    expect(shot.out).toMatchObject({ status: "inconclusive", ok: true, reason: null, pageStatus: null });
    expect(shot.out.artifacts).toHaveLength(1);
    expect(shot.out.artifacts[0]!.path).toBe(
      `.flowgraph/artifacts/${THREAD}/${NODE}/${path.basename(shot.out.path!)}`,
    );

    stubTools({ FAKE_LAUNCH_EXIT: "4" });
    const failed = await capture(mkdir(), ios({ app: "com.missing.app" }));
    expect(failed.out).toMatchObject({ status: "not_captured", ok: false, path: null, artifacts: [] });
  });

  it("does not capture the screen when the app failed to launch", async () => {
    stubTools({ FAKE_LAUNCH_EXIT: "4" });
    const { out, issues } = await capture(mkdir(), ios({ app: "com.missing.app" }));

    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/launch of "com\.missing\.app" failed \(exit 4\): app not installed/);
    expect(out.path).toBeNull();
    expect(issues[0]).toMatchObject({ code: "CAPTURE_FAILED" });
    expect(calls().filter((c) => c.includes("screenshot"))).toHaveLength(1); // the look before launching
  });

  it("captures only once the opened app has settled on screen", async () => {
    stubTools();
    const workspace = mkdir();
    const started = Date.now();
    const { out, issues } = await capture(workspace, ios({ app: "com.real.app" }));

    expect(out.ok).toBe(true);
    expect(fs.readFileSync(out.path!, "utf8")).toBe("app");
    expect(issues).toHaveLength(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
    expect(fs.readdirSync(path.dirname(out.path!))).toEqual([path.basename(out.path!)]);
  }, 15_000);

  it("warns when the screen never changes, or never holds still, but keeps the capture", async () => {
    stubTools({ FAKE_SCREEN: "frozen" });
    const frozen = await capture(mkdir(), ios({ app: "com.real.app", settle: "200ms" }));
    expect(frozen.out.ok).toBe(true);
    expect(frozen.issues[0]?.["message"]).toMatch(/did not change within 200ms/);
    vi.unstubAllEnvs();

    stubTools({ FAKE_SCREEN: "spinner" });
    const spinner = await capture(mkdir(), ios({ app: "com.real.app", settle: "200ms" }));
    expect(spinner.out.ok).toBe(true);
    expect(spinner.issues[0]?.["message"]).toMatch(/still changing after 200ms/);
  });

  it("fails on a bad deep link or an unbootable device", async () => {
    stubTools({ FAKE_OPENURL_EXIT: "1" });
    const link = await capture(mkdir(), ios({ deepLink: "myapp://x" }));
    expect(link.out.reason).toMatch(/openurl of "myapp:\/\/x" failed/);
    vi.unstubAllEnvs();

    stubTools({ FAKE_BOOT_EXIT: "148" });
    const boot = await capture(mkdir(), ios({ device: "No Such Phone" }));
    expect(boot.out.reason).toMatch(/boot of "No Such Phone" failed/);
  });

  it("keeps a recording stopped by us", async () => {
    stubTools();
    const { out } = await capture(mkdir(), ios({ capture: "video", duration: "150ms" }));
    expect(out).toMatchObject({ ok: true, mimeType: "video/mp4", sizeBytes: 3 });
  });

  it("starts recording before opening the app, and stops it if the launch fails", async () => {
    stubTools();
    const { out } = await capture(mkdir(), ios({ capture: "video", app: "com.real.app", settle: "1ms", duration: "1ms" }));
    expect(out).toMatchObject({ ok: true, mimeType: "video/mp4" });
    const order = calls().map((c) => c.split(" ").slice(0, 3).join(" "));
    expect(order.findIndex((c) => c.includes("recordVideo"))).toBeLessThan(order.findIndex((c) => c.includes("launch")));
    vi.unstubAllEnvs();

    stubTools({ FAKE_LAUNCH_EXIT: "4" });
    const workspace = mkdir();
    const failed = await capture(workspace, ios({ capture: "video", app: "com.missing.app" }));
    expect(failed.out.ok).toBe(false);
    expect(failed.out.reason).toMatch(/launch of "com\.missing\.app" failed/);
    expect(fs.readdirSync(path.join(workspace, ".flowgraph", "artifacts", THREAD, NODE))).toEqual([]);
  }, 15_000);

  it("rejects an empty recording", async () => {
    stubTools({ FAKE_RECORD: "empty" });
    const { out } = await capture(mkdir(), ios({ capture: "video", duration: "150ms" }));
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/did not produce a usable file/);
  });

  it("rejects a recorder that exits non-zero by itself, even with a file", async () => {
    stubTools({ FAKE_RECORD: "fail" });
    const { out } = await capture(mkdir(), ios({ capture: "video", duration: "5s" }));
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/exited 1: record broke/);
  });

  it("explains that simctl needs Xcode, at run time and in preflight", async () => {
    stubTools({ FAKE_NO_SIMCTL: "1" });
    const { out, issues } = await capture(mkdir(), ios());
    expect(out.reason).toMatch(/simctl is not installed/);
    expect(issues[0]).toMatchObject({ code: "TOOL_NOT_FOUND" });
    expect(issues[0]!["remediation"]).toMatch(/Install Xcode/);
    expect(issues[0]!["remediation"]).not.toMatch(/xcode-select --install/);

    const pre = await preflightGraphRequires(graphWith(ios()), { cwd: mkdir() });
    expect(pre.diagnostics[0]?.message).toMatch(/ships with Xcode/);
  });

  it("captures on Android, addressing the device by serial", async () => {
    stubTools();
    const shot = await capture(mkdir(), android({ device: "emulator-5554", app: "com.app", settle: "1ms" }));
    expect(shot.out).toMatchObject({ ok: true, mimeType: "image/png" });
    expect(calls()[1]).toContain("-s emulator-5554 shell monkey -p com.app");

    const video = await capture(mkdir(), android({ capture: "video", duration: "1ms" }));
    expect(video.out).toMatchObject({ ok: true, mimeType: "video/mp4" });
  });

  it("waits for an opened Android app to settle, despite status bar flicker", async () => {
    stubTools({ FAKE_SCREEN: "flicker" });
    const started = Date.now();
    const { out, issues } = await capture(mkdir(), android({ app: "com.app" }));

    expect(out.ok).toBe(true);
    expect(issues).toHaveLength(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
    const steps = calls().map((c) => c.split(" ").slice(0, 2).join(" "));
    expect(steps.indexOf("shell screencap")).toBeGreaterThan(steps.indexOf("shell monkey"));
  }, 15_000);

  it("warns when an Android screen never changes, or never holds still", async () => {
    stubTools({ FAKE_SCREEN: "frozen" });
    const frozen = await capture(mkdir(), android({ app: "com.app", settle: "200ms" }));
    expect(frozen.out.ok).toBe(true);
    expect(frozen.issues[0]?.["message"]).toMatch(/did not change within 200ms/);
    vi.unstubAllEnvs();

    stubTools({ FAKE_SCREEN: "spinner" });
    const spinner = await capture(mkdir(), android({ app: "com.app", settle: "200ms" }));
    expect(spinner.out.ok).toBe(true);
    expect(spinner.issues[0]?.["message"]).toMatch(/still changing after 200ms/);
  });

  it("records Android before opening the app, and cleans up if the launch fails", async () => {
    stubTools();
    const { out } = await capture(mkdir(), android({ capture: "video", app: "com.app", settle: "1ms", duration: "1ms" }));
    expect(out).toMatchObject({ ok: true, mimeType: "video/mp4" });
    const log = calls();
    const at = (text: string) => log.findIndex((c) => c.includes(text));
    expect(at("screenrecord --time-limit")).toBeLessThan(at("monkey"));
    expect(at("pidof screenrecord")).toBeLessThan(at("pull"));
    vi.unstubAllEnvs();

    stubTools({ FAKE_MONKEY: "none" });
    const failed = await capture(mkdir(), android({ capture: "video", app: "com.missing" }));
    expect(failed.out.ok).toBe(false);
    expect(calls().some((c) => c.includes("rm -f /sdcard/flowgraph-demo.mp4"))).toBe(true);
    expect(calls().some((c) => c.includes("pull"))).toBe(false);
  }, 15_000);

  it("sees Android failures that only appear as text", async () => {
    stubTools({ FAKE_MONKEY: "none" });
    const launch = await capture(mkdir(), android({ app: "com.missing" }));
    expect(launch.out.ok).toBe(false);
    expect(launch.out.reason).toBe('launch of "com.missing" failed: ** No activities found to run, monkey aborted.');
    vi.unstubAllEnvs();

    stubTools({ FAKE_AM: "error" });
    const link = await capture(mkdir(), android({ deepLink: "myapp://x" }));
    expect(link.out.ok).toBe(false);
    expect(link.out.reason).toMatch(/unable to resolve Intent/);
    vi.unstubAllEnvs();

    stubTools({ FAKE_SCREENCAP_EXIT: "1" });
    const shot = await capture(mkdir(), android());
    expect(shot.out.reason).toMatch(/adb screencap failed/);
  });
});

function graphWith(withConfig: Record<string, unknown>): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "demo-graph" },
    state: { channels: {} },
    nodes: [{ id: NODE, type: "demo", with: withConfig }],
    edges: [
      { from: "START", to: NODE },
      { from: NODE, to: "END" },
    ],
  } as unknown as GraphSpec;
}

describe("preflight for browser captures", () => {
  const screenshot = { screenshot: { url: "http://app/" } };

  const missing = "browserType.launch: Executable doesn't exist at /browsers/chrome-headless-shell";

  it("warns before the run when the browser is missing", async () => {
    const cwd = fakePlaywrightWorkspace({ launchError: missing });
    const res = await preflightGraphRequires(graphWith(screenshot), { cwd });

    expect(res.ok).toBe(true);
    expect(res.diagnostics[0]).toMatchObject({ severity: "warning", path: "nodes[0].with.screenshot" });
    expect(res.diagnostics[0]?.message).toMatch(/browser is not installed/);
  });

  it("blocks the run when the capture is strict", async () => {
    const cwd = fakePlaywrightWorkspace({ launchError: missing });
    const res = await preflightGraphRequires(graphWith({ strict: true, ...screenshot }), { cwd });

    expect(res.ok).toBe(false);
    expect(res.diagnostics[0]).toMatchObject({ severity: "error", code: "BIN_NOT_FOUND" });
  });

  it("goes by whether the capture's browser starts, not by where full Chrome is", async () => {
    const onlyHeadless = fakePlaywrightWorkspace({ executablePath: "/nonexistent/full-chrome" });
    expect((await preflightGraphRequires(graphWith(screenshot), { cwd: onlyHeadless })).diagnostics).toEqual([]);

    const fullChrome = path.join(mkdir(), "full-chrome");
    fs.writeFileSync(fullChrome, "");
    const onlyFull = fakePlaywrightWorkspace({ executablePath: fullChrome, launchError: missing });
    const res = await preflightGraphRequires(graphWith(screenshot), { cwd: onlyFull });
    expect(res.diagnostics[0]?.message).toMatch(/browser is not installed/);
  });

  it("does not suggest installing a browser that is there but will not start", async () => {
    const cwd = fakePlaywrightWorkspace({ launchError: "browserType.launch: Target closed\nCall log:\n  - details" });
    const res = await preflightGraphRequires(graphWith(screenshot), { cwd });

    expect(res.diagnostics[0]?.message).toContain("could not start: browserType.launch: Target closed");
    expect(res.diagnostics[0]?.message).not.toMatch(/npx playwright install|Call log/);
  });

  it("checks ffmpeg only for captures that record", async () => {
    const cwd = fakePlaywrightWorkspace({
      videoError: "browserContext.newPage: Executable doesn't exist at /browsers/ffmpeg-mac",
    });
    const video = { video: { url: "http://app/" } };

    expect((await preflightGraphRequires(graphWith(screenshot), { cwd })).diagnostics).toEqual([]);
    for (const withConfig of [video, { screenshot: { url: "http://app/", video: true } }]) {
      const res = await preflightGraphRequires(graphWith(withConfig), { cwd });
      expect(res.diagnostics[0]?.message).toMatch(/browser is not installed/);
    }
  });

  it("stays quiet when captures can run, and for modes that need no browser", async () => {
    const cwd = fakePlaywrightWorkspace();

    expect((await preflightGraphRequires(graphWith(screenshot), { cwd })).diagnostics).toEqual([]);
    expect((await preflightGraphRequires(graphWith({ video: { url: "http://app/" } }), { cwd })).diagnostics).toEqual([]);
    expect((await preflightGraphRequires(graphWith({ file: { path: "a" } }), { cwd: mkdir() })).diagnostics).toEqual([]);
  });
});

/** A port nothing listens on: a refused connection, as when the app under test is down. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const sha256Of = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

describe("result status, fields and artifacts", () => {
  let server: http.Server;
  let base: string;
  let refused: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      res.writeHead(Number(url.searchParams.get("status") ?? 200), { "content-type": "text/plain" });
      res.end("body");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    refused = `http://127.0.0.1:${await closedPort()}/`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  function attachable(): { workspace: string; source: string; missing: string } {
    const workspace = mkdir();
    const source = path.join(workspace, "note.txt");
    fs.writeFileSync(source, "hello", "utf8");
    return { workspace, source, missing: path.join(workspace, "gone.txt") };
  }

  /** Every mode, in each outcome it can reach without an objective. */
  async function outcomes(): Promise<Record<string, DemoResult>> {
    const file = attachable();
    const run = async (workspace: string, config: Record<string, unknown>) => (await capture(workspace, config)).out;
    return {
      httpOk: await run(mkdir(), { http: { url: `${base}/` } }),
      http500: await run(mkdir(), { http: { url: `${base}/?status=500` } }),
      httpRefused: await run(mkdir(), { http: { url: refused } }),
      screenshotOk: await run(fakePlaywrightWorkspace(), { screenshot: { url: "http://app/" } }),
      screenshot500: await run(fakePlaywrightWorkspace({ status: 500 }), { screenshot: { url: "http://app/" } }),
      screenshotRefused: await run(fakePlaywrightWorkspace({ gotoError: "net::ERR_CONNECTION_REFUSED" }), {
        screenshot: { url: "http://app/" },
      }),
      videoOk: await run(fakePlaywrightWorkspace(), { video: { url: "http://app/", duration: "1ms" } }),
      video502: await run(fakePlaywrightWorkspace({ status: 502 }), { video: { url: "http://app/", duration: "1ms" } }),
      noBrowser: await run(fakePlaywrightWorkspace({ launchError: "Executable doesn't exist at /x" }), {
        screenshot: { url: "http://app/" },
      }),
      fileOk: await run(file.workspace, { file: { path: file.source } }),
      fileMissing: await run(file.workspace, { file: { path: file.missing } }),
    };
  }

  it("gives each existing mode only failed, inconclusive or not_captured, and derives ok from it", async () => {
    const r = await outcomes();
    const status = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [v.status, v.ok]]));
    expect(status).toEqual({
      httpOk: ["inconclusive", true],
      http500: ["failed", false],
      httpRefused: ["not_captured", false],
      screenshotOk: ["inconclusive", true],
      screenshot500: ["failed", false],
      screenshotRefused: ["not_captured", false],
      videoOk: ["inconclusive", true],
      video502: ["failed", false],
      noBrowser: ["not_captured", false],
      fileOk: ["inconclusive", true],
      fileMissing: ["not_captured", false],
    });
  });

  it("writes every field in every mode and outcome, null when absent", async () => {
    const r = await outcomes();
    const keys = [
      "ok", "status", "kind", "path", "mimeType", "sizeBytes", "reason", "capturedAt", "label",
      "extra", "pageStatus", "request", "response", "artifacts",
    ].sort();
    for (const [name, out] of Object.entries(r)) {
      expect(Object.keys(out).sort(), name).toEqual(keys);
      // JSON has no undefined, so a missing field would be dropped on its way into state.
      expect(Object.keys(JSON.parse(JSON.stringify(out))).sort(), name).toEqual(keys);
    }

    expect(r["httpOk"]).toMatchObject({ reason: null, label: null, extra: null, pageStatus: null });
    expect(r["httpOk"]!.request).not.toBeNull();
    expect(r["screenshotOk"]).toMatchObject({ request: null, response: null, pageStatus: 200 });
    expect(r["fileOk"]).toMatchObject({ request: null, response: null, pageStatus: null });
    for (const name of ["httpRefused", "screenshotRefused", "noBrowser", "fileMissing"]) {
      expect(r[name], name).toMatchObject({
        path: null, mimeType: null, sizeBytes: null, extra: null, pageStatus: null, request: null, response: null, artifacts: [],
      });
      expect(typeof r[name]!.reason).toBe("string");
    }
  });

  it("writes under .flowgraph/artifacts/<thread>/<node>/ and describes each file", async () => {
    const workspace = mkdir();
    const { out } = await capture(workspace, { label: "health", http: { url: `${base}/` } });

    const dir = path.join(workspace, ".flowgraph", "artifacts", THREAD, NODE);
    expect(path.dirname(out.path!)).toBe(dir);
    expect(out.artifacts).toHaveLength(1);
    const [artifact] = out.artifacts;
    expect(artifact).toMatchObject({
      kind: "artifact",
      path: `.flowgraph/artifacts/${THREAD}/${NODE}/${path.basename(out.path!)}`,
      mimeType: "application/json",
      role: "file",
      sizeBytes: fs.statSync(out.path!).size,
      sha256: sha256Of(out.path!),
    });
    // `path` stays absolute for existing graphs and names the same file.
    expect(path.isAbsolute(out.path!)).toBe(true);
    expect(path.resolve(workspace, artifact!.path)).toBe(out.path);
  });

  it("lists a screenshot and its recording, main file first, and leaves no raw recording behind", async () => {
    const workspace = fakePlaywrightWorkspace();
    const { out } = await capture(workspace, { screenshot: { url: "http://app/", video: true } });

    expect(out.artifacts.map((a) => [a.role, a.mimeType])).toEqual([
      ["image", "image/png"],
      ["video", "video/webm"],
    ]);
    expect(out.artifacts.map((a) => path.resolve(workspace, a.path))).toEqual([out.path, out.extra![0]!.path]);
    for (const a of out.artifacts) expect(a.sha256).toBe(sha256Of(path.resolve(workspace, a.path)));
    expect(fs.readdirSync(path.dirname(out.path!)).sort()).toEqual(
      [path.basename(out.path!), path.basename(out.extra![0]!.path)].sort(),
    );
  });

  it("keeps the evidence of a failed capture in artifacts, and has none for a capture that never happened", async () => {
    const failed = await capture(fakePlaywrightWorkspace({ status: 500 }), { screenshot: { url: "http://app/" } });
    expect(failed.out).toMatchObject({ status: "failed", ok: false });
    expect(failed.out.artifacts).toHaveLength(1);
    expect(fs.existsSync(failed.out.path!)).toBe(true);

    const none = await capture(fakePlaywrightWorkspace({ gotoError: "net::ERR_CONNECTION_REFUSED" }), {
      screenshot: { url: "http://app/", video: true },
    });
    expect(none.out).toMatchObject({ status: "not_captured", artifacts: [] });
  });

  it("leaves nothing in the artifact folder when the page cannot be reached", async () => {
    const workspace = fakePlaywrightWorkspace({ gotoError: "net::ERR_CONNECTION_REFUSED" });
    await capture(workspace, { screenshot: { url: "http://app/", video: true } });
    await capture(workspace, { video: { url: "http://app/", duration: "1ms" } });

    expect(fs.readdirSync(path.join(workspace, ".flowgraph", "artifacts", THREAD, NODE))).toEqual([]);
  });

  it("leaves nothing in the artifact folder when the browser cannot start", async () => {
    const workspace = fakePlaywrightWorkspace({
      launchError: "browserType.launch: Executable doesn't exist at /browsers/chrome-headless-shell",
    });
    const shot = await capture(workspace, { screenshot: { url: "http://app/", video: true } });
    const video = await capture(workspace, { video: { url: "http://app/", duration: "1ms" } });

    expect(shot.out.status).toBe("not_captured");
    expect(video.out.status).toBe("not_captured");
    expect(fs.readdirSync(path.join(workspace, ".flowgraph", "artifacts", THREAD, NODE))).toEqual([]);
  });

  it("keeps no empty recording", async () => {
    const workspace = fakePlaywrightWorkspace({ emptyVideo: true });
    const dir = path.join(workspace, ".flowgraph", "artifacts", THREAD, NODE);

    const video = await capture(workspace, { video: { url: "http://app/", duration: "1ms" } });
    expect(video.out).toMatchObject({ status: "not_captured", path: null, artifacts: [] });
    expect(fs.readdirSync(dir)).toEqual([]);

    const shot = await capture(workspace, { screenshot: { url: "http://app/", video: true } });
    expect(shot.out).toMatchObject({ status: "inconclusive", extra: null });
    expect(shot.out.artifacts).toHaveLength(1);
    expect(fs.readdirSync(dir).map((f) => path.extname(f))).toEqual([".png"]);
  });

  it("records status and artifacts in the manifest, which stays where Desktop reads it", async () => {
    const workspace = mkdir();
    const { out } = await capture(workspace, { http: { url: `${base}/?status=500` } });
    await capture(workspace, { http: { url: refused } });

    expect(fs.existsSync(path.join(workspace, ".flowgraph", "demo", "runs", THREAD, "manifest.jsonl"))).toBe(true);
    const [failed, none] = readDemoManifest(workspace, THREAD);
    expect(failed).toMatchObject({ ok: false, status: "failed", path: out.path, artifacts: out.artifacts });
    expect(none).toMatchObject({ ok: false, status: "not_captured" });
    expect(none).not.toHaveProperty("artifacts");
  });
});


// Cancelling a run (ADR-0019 §10): every mode stops its capture and leaves nothing behind. A
// cancel is the run being aborted, not a capture that failed, so it raises no issue and writes
// no manifest entry, and `strict` has no failure to turn into an error.
describe("cancellation", () => {
  const artifactFolder = (workspace: string) => path.join(workspace, ".flowgraph", "artifacts", THREAD, NODE);
  const playwrightLog = (workspace: string) => {
    const file = path.join(workspace, "playwright.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Run a capture and cancel it. It must not complete. `ms` counts from the abort.
   *
   * `when` cancels as soon as the capture has reached the point being tested, so a slow machine
   * cannot move the cancel to some other point. `before`: before it starts. `returning`: the moment
   * `run` has been called, which for a capture that is synchronous up to its last await is after
   * the capture and before the node returns.
   */
  async function cancelled(
    workspace: string,
    withConfig: Record<string, unknown>,
    opts: { at?: "before" | "returning"; when?: () => boolean; state?: Record<string, unknown> },
  ) {
    const controller = new AbortController();
    const issues: Array<Record<string, unknown>> = [];
    let abortedAt: number | undefined;
    controller.signal.addEventListener("abort", () => {
      abortedAt = Date.now();
    });
    if (opts.at === "before") controller.abort();
    const started = Date.now();
    const waiting = opts.when
      ? setInterval(() => {
          // Never reached: cancel anyway, and the test's own checks report what went wrong.
          if (opts.when!() || Date.now() - started > 8_000) {
            clearInterval(waiting);
            controller.abort();
          }
        }, 10)
      : undefined;
    const running = capture(workspace, withConfig, {
      signal: controller.signal,
      issues,
      ...(opts.state ? { state: opts.state } : {}),
    });
    if (opts.at === "returning") controller.abort();
    const error: unknown = await running.then(
      () => {
        throw new Error("the capture finished instead of being cancelled");
      },
      (err: unknown) => err,
    );
    clearInterval(waiting);
    const ms = Date.now() - (abortedAt ?? started);
    // The abort reaches the run as it was raised, so the run reports itself as aborted.
    expect(error).toBe(controller.signal.reason);
    expect(issues).toEqual([]);
    expect(readDemoManifest(workspace, THREAD)).toEqual([]);
    const folder = artifactFolder(workspace);
    expect(fs.existsSync(folder) ? fs.readdirSync(folder) : []).toEqual([]);
    return { ms };
  }

  describe("browser modes", () => {
    const cases: Array<[string, Record<string, unknown>, "goto" | "waitForSelector" | "waitForTimeout" | "screenshot"]> = [
      ["a screenshot loading the page", { screenshot: { url: "http://app/" } }, "goto"],
      ["a screenshot waiting on a selector", { screenshot: { url: "http://app/", waitFor: "#never", timeout: "1h" } }, "waitForSelector"],
      ["a screenshot waiting out a duration", { screenshot: { url: "http://app/", waitFor: "1h" } }, "waitForTimeout"],
      ["a screenshot taking the picture", { screenshot: { url: "http://app/" } }, "screenshot"],
      ["a screenshot that also records", { screenshot: { url: "http://app/", video: true, waitFor: "1h" } }, "waitForTimeout"],
      ["a video loading the page", { video: { url: "http://app/" } }, "goto"],
      ["a video waiting on a selector", { video: { url: "http://app/", waitFor: "#never", timeout: "1h" } }, "waitForSelector"],
      ["a video recording for its duration", { video: { url: "http://app/", duration: "1h" } }, "waitForTimeout"],
    ];

    it.each(cases)("stops %s: closes the context and the browser, and keeps nothing", async (_name, config, hang) => {
      const workspace = fakePlaywrightWorkspace({ hang });
      const { ms } = await cancelled(workspace, config, { when: () => playwrightLog(workspace).includes("hang") });

      expect(ms).toBeLessThan(3_000);
      const log = playwrightLog(workspace);
      expect(log).toContain("context.close");
      expect(log).toContain("browser.close");
      expect(fs.readdirSync(artifactFolder(workspace))).toEqual([]); // no .recording- folder either
    }, 10_000);

    it("is a cancellation under strict too, not a capture error", async () => {
      const workspace = fakePlaywrightWorkspace({ hang: "waitForSelector" });
      await cancelled(workspace, { strict: true, screenshot: { url: "http://app/", waitFor: "#never", timeout: "1h" } }, {
        when: () => playwrightLog(workspace).includes("hang"),
      });
    }, 10_000);

    it("does not launch a browser for a run cancelled before the capture starts", async () => {
      for (const config of [{ screenshot: { url: "http://app/" } }, { video: { url: "http://app/" } }]) {
        const workspace = fakePlaywrightWorkspace();
        await cancelled(workspace, config, { at: "before" });
        expect(playwrightLog(workspace)).toEqual([]);
        expect(fs.existsSync(artifactFolder(workspace))).toBe(false);
      }
    });

    it("closes a browser that was still starting when the run was cancelled", async () => {
      const workspace = fakePlaywrightWorkspace({ launchMs: 1_000 });
      const { ms } = await cancelled(workspace, { video: { url: "http://app/" } }, {
        when: () => playwrightLog(workspace).includes("launch"),
      });

      expect(ms).toBeLessThan(3_000);
      expect(playwrightLog(workspace)).toEqual(["launch", "browser.close"]);
    }, 10_000);
  });

  describe("node timeout", () => {
    async function runGraph(workspace: string, node: Record<string, unknown>) {
      const compiled = await compileGraph(
        {
          metadata: { name: "timeout-demo" },
          state: { channels: {} },
          nodes: [{ id: NODE, type: "demo", ...node }],
          edges: [
            { from: "START", to: NODE },
            { from: NODE, to: "END" },
          ],
          runtime: { workspace, checkpoint: { enabled: false } },
        } as unknown as GraphSpec,
        {},
      );
      return compiled.run({ threadId: THREAD });
    }
    const folderFiles = (workspace: string) => {
      const folder = artifactFolder(workspace);
      return fs.existsSync(folder) ? fs.readdirSync(folder) : [];
    };

    it("stops the capture and fails the attempt as timed out", async () => {
      const workspace = fakePlaywrightWorkspace({ hang: "waitForTimeout" });
      const result = await runGraph(workspace, { timeout: "300ms", with: { video: { url: "http://app/", duration: "1h" } } });

      expect(result.status).toBe("error");
      expect(result.error?.message).toContain("Node timed out");
      await vi.waitFor(() => expect(playwrightLog(workspace)).toContain("browser.close"));
      expect(playwrightLog(workspace)).toContain("context.close");
      expect(folderFiles(workspace)).toEqual([]);
      expect(readDemoManifest(workspace, THREAD)).toEqual([]);
    }, 15_000);

    it("stops a capture inside a map too", async () => {
      const workspace = fakePlaywrightWorkspace({ hang: "waitForTimeout" });
      const compiled = await compileGraph(
        {
          metadata: { name: "timeout-map" },
          state: { channels: { items: { type: "array" } } },
          nodes: [
            {
              id: NODE,
              type: "map",
              timeout: "300ms",
              with: {
                over: "{{ state.items }}",
                node: { type: "demo", with: { video: { url: "http://app/", duration: "1h" } } },
              },
            },
          ],
          edges: [
            { from: "START", to: NODE },
            { from: NODE, to: "END" },
          ],
          runtime: { workspace, checkpoint: { enabled: false } },
        } as unknown as GraphSpec,
        {},
      );
      const result = await compiled.run({ threadId: THREAD, input: { items: ["one"] } });

      expect(result.status).toBe("error");
      expect(result.error?.message).toContain("Node timed out");
      await vi.waitFor(() => expect(playwrightLog(workspace)).toContain("browser.close"));
    }, 15_000);

    it("closes the first browser before a retry opens the next", async () => {
      const workspace = fakePlaywrightWorkspace({ hang: "waitForTimeout" });
      const result = await runGraph(workspace, {
        timeout: "300ms",
        retry: { maxAttempts: 2, baseMs: 1, jitter: false },
        with: { video: { url: "http://app/", duration: "1h" } },
      });

      expect(result.status).toBe("error");
      await vi.waitFor(() => expect(playwrightLog(workspace).filter((l) => l === "launch")).toHaveLength(2));
      const log = playwrightLog(workspace);
      expect(log.indexOf("browser.close")).toBeGreaterThan(-1);
      expect(log.indexOf("browser.close")).toBeLessThan(log.lastIndexOf("launch"));
    }, 15_000);
  });

  describe("signal handling in the browser", () => {
    const launchOptions = async (signal?: AbortSignal) => {
      const launch = vi.fn(async () => ({ newContext: vi.fn(), close: vi.fn() }));
      await launchCaptureBrowser({ chromium: { launch } } as never, signal);
      return launch.mock.calls[0] as unknown[];
    };

    it("leaves Ctrl-C to the host when the host passes a signal", async () => {
      // Playwright's own handlers would close the browser and exit before the abort could clean up.
      expect((await launchOptions(new AbortController().signal))[0]).toMatchObject({
        headless: true,
        handleSIGINT: false,
        handleSIGTERM: false,
      });
    });

    it("keeps Playwright's handlers when nothing else would close the browser", async () => {
      const [options] = await launchOptions();
      expect(options).toEqual({ headless: true });
    });
  });

  describe("http and file modes", () => {
    let server: http.Server;
    let base: string;
    let requests = 0;
    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        requests++;
        setTimeout(() => res.end("late"), 20_000).unref();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => {
      server.closeAllConnections();
      server.close();
    });

    it("stops an http request in flight, even under strict and a timeout", async () => {
      const inFlight = () => {
        const seen = requests;
        return () => requests > seen;
      };
      const { ms } = await cancelled(mkdir(), { strict: true, http: { url: `${base}/`, timeout: "5s" } }, { when: inFlight() });
      expect(ms).toBeLessThan(2_000);
      const slow = await cancelled(mkdir(), { http: { url: `${base}/`, timeout: "1h" } }, { when: inFlight() });
      expect(slow.ms).toBeLessThan(2_000);
    });

    it("does not send a request, or copy a file, for a run cancelled before the capture starts", async () => {
      await cancelled(mkdir(), { http: { url: `${base}/` } }, { at: "before" });

      const workspace = mkdir();
      fs.writeFileSync(path.join(workspace, "report.txt"), "report");
      await cancelled(workspace, { file: { path: "./report.txt" } }, { at: "before" });
      expect(fs.existsSync(artifactFolder(workspace))).toBe(false);
    });

    it("keeps nothing when the cancel arrives after the capture finished, before the node returns", async () => {
      const workspace = mkdir();
      fs.writeFileSync(path.join(workspace, "report.txt"), "report");
      await cancelled(workspace, { file: { path: "./report.txt" } }, { at: "returning" });
    });

    it("ends a compiled run as aborted, with no issue raised", async () => {
      const workspace = mkdir();
      const events: FlowgraphEvent[] = [];
      const compiled = await compileGraph(
        {
          metadata: { name: "cancel-demo" },
          state: { channels: {} },
          nodes: [{ id: NODE, type: "demo", with: { strict: true, http: { url: `${base}/`, timeout: "1h" } } }],
          edges: [
            { from: "START", to: NODE },
            { from: NODE, to: "END" },
          ],
          runtime: { workspace, checkpoint: { enabled: false } },
        } as unknown as GraphSpec,
        { sinks: [(ev) => void events.push(ev)] },
      );
      const controller = new AbortController();
      compiled.events.subscribe((ev) => {
        if (ev.type === "node.start") setTimeout(() => controller.abort(), 100);
      });

      const started = Date.now();
      const result = await compiled.run({ signal: controller.signal });

      expect(result.status).toBe("aborted");
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(events.some((e) => e.type === "run.issue" || e.type === "run.error")).toBe(false);
      expect(readDemoManifest(workspace, THREAD)).toEqual([]);
    });
  });

  describe.skipIf(process.platform === "win32")("simulator", () => {
    let log: string;
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
    const pids = () =>
      fs.existsSync(`${log}.pids`)
        ? fs.readFileSync(`${log}.pids`, "utf8").trim().split("\n").map(Number)
        : [];
    /** A fake tool has started and is now stuck, or recording. */
    const started = () => pids().length > 0;
    /** The settle wait is under way: frames are being grabbed after the app was opened. */
    const polling = (frame: string) => () => calls().filter((c) => c.includes(frame)).length >= 3;

    function stubTools(env: Record<string, string> = {}): void {
      const bin = mkdir("fg-demo-bin-");
      fs.writeFileSync(path.join(bin, "xcrun"), FAKE_XCRUN, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "adb"), FAKE_ADB, { mode: 0o755 });
      log = path.join(bin, "calls.log");
      vi.stubEnv("PATH", `${bin}:${process.env["PATH"]}`);
      vi.stubEnv("FAKE_LOG", log);
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    }
    afterEach(() => vi.unstubAllEnvs());

    const ios = (extra: Record<string, unknown> = {}) => ({ simulator: { platform: "ios", capture: "screenshot", ...extra } });
    const android = (extra: Record<string, unknown> = {}) => ({ simulator: { platform: "android", capture: "screenshot", ...extra } });

    it("runs no tool for a run cancelled before the capture starts", async () => {
      stubTools();
      await cancelled(mkdir(), ios(), { at: "before" });
      await cancelled(mkdir(), android({ capture: "video" }), { at: "before" });
      expect(calls()).toEqual([]);
    });

    it("stops waiting for an iOS app to settle", async () => {
      stubTools({ FAKE_SCREEN: "spinner" });
      const { ms } = await cancelled(mkdir(), ios({ app: "com.real.app", settle: "1h" }), { when: polling("io booted screenshot") });

      expect(ms).toBeLessThan(3_000);
      const seen = calls().length;
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(calls()).toHaveLength(seen); // nothing keeps polling the screen
    }, 15_000);

    it("kills a stuck simctl step", async () => {
      stubTools({ FAKE_BOOT_HANG: "1" });
      const { ms } = await cancelled(mkdir(), ios({ device: "iPhone 15" }), { when: started });

      expect(ms).toBeLessThan(3_000);
      expect(pids()).toHaveLength(1);
      expect(alive(pids()[0]!)).toBe(false);
    }, 15_000);

    it("stops simctl recordVideo and deletes the file", async () => {
      stubTools();
      const workspace = mkdir();
      const { ms } = await cancelled(workspace, ios({ capture: "video", duration: "1h" }), { when: started });

      expect(ms).toBeLessThan(5_000);
      expect(pids()).toHaveLength(1);
      expect(alive(pids()[0]!)).toBe(false); // the recorder is gone, not left running
    }, 15_000);

    it("keeps no recording that was still being finalized when the run was cancelled", async () => {
      stubTools({ FAKE_RECORD: "slowstop" });
      const workspace = mkdir();
      // The recorder is told to stop after 1s and needs 1.5s to write the file: the cancel lands in between.
      await cancelled(workspace, ios({ capture: "video", duration: "1s" }), { when: () => fs.existsSync(`${log}.stopping`) });

      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(fs.readdirSync(artifactFolder(workspace))).toEqual([]); // not even when the recorder writes late
    }, 15_000);

    it("keeps no screenshot that the simulator writes after simctl was killed", async () => {
      stubTools({ FAKE_SHOT_LATE: "1" });
      const workspace = mkdir();
      await cancelled(workspace, ios(), { when: started });

      await new Promise((resolve) => setTimeout(resolve, 2_000)); // the late write lands in this time
      expect(fs.readdirSync(artifactFolder(workspace))).toEqual([]);
    }, 15_000);

    it("stops waiting for an Android app to settle", async () => {
      stubTools({ FAKE_SCREEN: "spinner" });
      const { ms } = await cancelled(mkdir(), android({ app: "com.app", settle: "1h" }), { when: polling("exec-out screencap") });

      expect(ms).toBeLessThan(3_000);
      const seen = calls().length;
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(calls()).toHaveLength(seen);
    }, 15_000);

    it("stops screenrecord on the device and deletes its file, not only the adb client", async () => {
      stubTools({ FAKE_DEVICE_RECORDER: "1" });
      const { ms } = await cancelled(mkdir(), android({ capture: "video", duration: "1h" }), { when: () => fs.existsSync(`${log}.device-recording`) });

      expect(ms).toBeLessThan(5_000);
      expect(alive(pids()[0]!)).toBe(false); // the adb client
      expect(fs.existsSync(`${log}.device-recording`)).toBe(false); // the recorder on the device
      expect(fs.existsSync(`${log}.device-file`)).toBe(false); // and its temp file
      expect(calls().some((c) => c.includes("shell kill -2 4242"))).toBe(true);
      expect(calls().some((c) => c.includes("pull"))).toBe(false);
      // The separate process that does this for a host that exits at once, which the awaited
      // cleanup above would hide if it were never started.
      expect(
        calls().some(
          (c) =>
            c.includes("shell for s in -2 -9;") &&
            c.includes("kill $s $p") &&
            c.includes("rm -f /sdcard/flowgraph-demo.mp4"),
        ),
      ).toBe(true);
    }, 15_000);

    it("deletes the temp screenshot from the device when cancelled mid-capture", async () => {
      stubTools({ FAKE_SCREENCAP_HANG: "1" });
      fs.writeFileSync(`${log}.device-file`, "x");
      const { ms } = await cancelled(mkdir(), android(), { when: started });

      expect(ms).toBeLessThan(3_000);
      expect(alive(pids()[0]!)).toBe(false);
      expect(calls().some((c) => c.includes("shell rm -f /sdcard/flowgraph-demo.png"))).toBe(true);
    }, 15_000);
  });
});
