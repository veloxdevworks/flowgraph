/**
 * Mobile-simulator capture for the `demo` node (iOS via simctl, Android via adb).
 * Every step is checked: a failed launch throws rather than recording whatever
 * happens to be on screen, and the demo node turns the throw into `ok: false`.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseDuration } from "../runtime/duration.js";
import { checkBinOnPath } from "../runtime/which.js";

export type SimulatorConfig = {
  platform: "ios" | "android";
  device?: string | undefined;
  app?: string | undefined;
  deepLink?: string | undefined;
  capture?: "video" | "screenshot" | undefined;
  duration?: string | undefined;
  settle?: string | undefined;
};

export type SimulatorCapture = {
  path: string;
  mimeType: string;
  sizeBytes: number;
  /** The capture worked, but it may not show what was asked for. */
  warning?: string;
};

/** Writing out a long recording can take a while after the stop signal. */
const FINALIZE_GRACE_MS = 15_000;

/** How long the screen must hold still to count as settled, and how often to look. */
const SETTLE_STABLE_MS = 3_000;
const SETTLE_POLL_MS = 500;

/** `adb exec-out screencap`: a 16-byte header, then 4 bytes per pixel. */
const ANDROID_FRAME_HEADER = 16;
/** The share of pixels that may differ between frames of the same screen. */
const ANDROID_FRAME_TOLERANCE = 0.001;

/** `screenrecord` refuses to run for longer than this. */
const ANDROID_RECORD_LIMIT_SECONDS = 180;

type RunOptions = {
  timeoutMs?: number;
  /** Aborting kills the process and rejects with the signal's reason. */
  signal?: AbortSignal | undefined;
};

function run(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveP, reject) => {
    const { signal } = opts;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const onAbort = (): void => {
      clearTimeout(timer);
      // Report the cancel only once the process is gone, so nothing outlives the node.
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(signal?.reason);
        return;
      }
      child.once("exit", () => reject(signal?.reason));
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, opts.timeoutMs ?? 60_000);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c: Buffer) => { stdout += String(c); });
    child.stderr?.on("data", (c: Buffer) => { stderr += String(c); });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveP({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

/** Wait `ms`, or reject with the signal's reason as soon as it aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveP, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveP();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Run a required step; a non-zero exit is a failed capture. */
async function runStep(
  what: string,
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await run(cmd, args, opts);
  if (result.exitCode !== 0) {
    throw new Error(`${what} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

function assertNotEmpty(path: string, what: string): number {
  const size = existsSync(path) ? statSync(path).size : 0;
  if (size === 0) throw new Error(`${what} did not produce a usable file`);
  return size;
}

/**
 * True when simctl is usable. `xcrun` alone proves nothing: macOS ships a stub of it,
 * and simctl comes with Xcode, not the command-line tools.
 */
export async function iosToolchainReady(): Promise<boolean> {
  if (!(await checkBinOnPath("xcrun"))) return false;
  try {
    return (await run("xcrun", ["--find", "simctl"])).exitCode === 0;
  } catch {
    return false;
  }
}

export async function captureSimulator(
  config: SimulatorConfig,
  opts: {
    artifactDir: string;
    fileSlug: string;
    /** Aborting stops every capture process, including a recorder running on the device. */
    signal?: AbortSignal;
  },
): Promise<SimulatorCapture> {
  opts.signal?.throwIfAborted();
  const capture = config.capture ?? "video";
  const durationMs = config.duration ? parseDuration(config.duration) : 10_000;

  if (config.platform === "ios") {
    if (!(await iosToolchainReady())) {
      throw new Error("simctl is not installed. It ships with Xcode, not the command-line tools.");
    }
    return captureIos(config, { ...opts, capture, durationMs });
  }
  if (!(await checkBinOnPath("adb"))) {
    throw new Error("adb is not installed. Install the Android SDK platform-tools and ensure adb is on PATH.");
  }
  return captureAndroid(config, { ...opts, capture, durationMs });
}

async function captureIos(
  config: SimulatorConfig,
  opts: {
    artifactDir: string;
    fileSlug: string;
    capture: "video" | "screenshot";
    durationMs: number;
    signal?: AbortSignal | undefined;
  },
): Promise<SimulatorCapture> {
  const { signal } = opts;
  const device = config.device?.trim();
  if (device) {
    // Boots if needed, waits until usable, and is fine with a device already running.
    await runStep(`simctl boot of "${device}"`, "xcrun", ["simctl", "bootstatus", device, "-b"], {
      timeoutMs: 180_000,
      signal,
    });
  }
  mkdirSync(opts.artifactDir, { recursive: true });
  const target = device || "booted";
  const opening = Boolean(config.app || config.deepLink);
  return withScratchFolder(opts.artifactDir, signal, (scratch) =>
    captureIosOnDevice(config, { ...opts, target, opening, scratch }),
  );
}

/**
 * Everything a capture writes before it is known to be good lives in a folder of its own inside
 * the artifacts folder (not the system temp folder: a workspace on another drive would make the
 * move into place fail), and only a finished file is moved out of it. The simulator finishes
 * writing a screenshot or recording even after the `simctl` that asked for it is killed, so a
 * cancel removes the whole folder, synchronously at the abort, which leaves a late write nowhere
 * to land. It is removed on every other way out too, so it cannot be left behind.
 */
async function withScratchFolder<T>(
  artifactDir: string,
  signal: AbortSignal | undefined,
  use: (scratch: string) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const scratch = mkdtempSync(join(artifactDir, ".recording-"));
  const drop = (): void => rmSync(scratch, { recursive: true, force: true });
  signal?.addEventListener("abort", drop, { once: true });
  try {
    return await use(scratch);
  } finally {
    signal?.removeEventListener("abort", drop);
    drop();
  }
}

async function captureIosOnDevice(
  config: SimulatorConfig,
  opts: {
    artifactDir: string;
    fileSlug: string;
    capture: "video" | "screenshot";
    durationMs: number;
    signal?: AbortSignal | undefined;
    target: string;
    opening: boolean;
    scratch: string;
  },
): Promise<SimulatorCapture> {
  const { signal, target, opening, scratch } = opts;
  const frameFile = join(scratch, "frame.png");
  const before = opening ? await grabIosFrame(target, frameFile, signal) : undefined;
  const open = async (): Promise<SimulatorCapture["warning"]> => {
    if (config.app) {
      await runStep(`simctl launch of "${config.app}"`, "xcrun", ["simctl", "launch", target, config.app], { signal });
    }
    if (config.deepLink) {
      await runStep(`simctl openurl of "${config.deepLink}"`, "xcrun", ["simctl", "openurl", target, config.deepLink], { signal });
    }
    return opening
      ? waitForScreen(() => grabIosFrame(target, frameFile, signal), (a, b) => a.equals(b), before, config.settle ?? DEFAULT_SETTLE, signal)
      : undefined;
  };

  if (opts.capture === "screenshot") {
    const warning = await open();
    const shot = join(scratch, "screenshot.png");
    await runStep("simctl screenshot", "xcrun", ["simctl", "io", target, "screenshot", shot], { signal });
    const sizeBytes = assertNotEmpty(shot, "simctl screenshot");
    const dest = join(opts.artifactDir, `${opts.fileSlug}.png`);
    renameSync(shot, dest);
    return { path: dest, mimeType: "image/png", sizeBytes, ...(warning ? { warning } : {}) };
  }

  // simctl writes a frame only when the screen changes, so recording must already be
  // running when the app opens: started after it settled, a 3s clip comes out as one frame.
  const video = join(scratch, "recording.mp4");
  const recorder = startRecording("xcrun", ["simctl", "io", target, "recordVideo", "--codec=h264", video], signal);
  let warning: SimulatorCapture["warning"];
  try {
    if (opening) await recorder.ready;
    warning = await open();
    await recorder.runFor(opts.durationMs);
    await recorder.stop();
  } catch (err) {
    // Wait for the recorder to exit before the scratch folder goes, so it has nowhere to write late.
    await recorder.stop().catch(() => {});
    throw err;
  }
  const sizeBytes = assertNotEmpty(video, "simctl recordVideo");
  const dest = join(opts.artifactDir, `${opts.fileSlug}.mp4`);
  renameSync(video, dest);
  return { path: dest, mimeType: "video/mp4", sizeBytes, ...(warning ? { warning } : {}) };
}

const DEFAULT_SETTLE = "30s";

async function grabIosFrame(target: string, file: string, signal?: AbortSignal): Promise<Buffer | undefined> {
  try {
    const result = await run("xcrun", ["simctl", "io", target, "screenshot", file], { signal });
    return result.exitCode === 0 && existsSync(file) ? readFileSync(file) : undefined;
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * `simctl` and `adb` report a launch as done long before the screen shows it: on a cold
 * iOS boot the Apple logo can stay up for a minute after `launch` returned, and an Android
 * launch can draw nothing for over a second. Wait until the screen has changed and held
 * still. A spinner or animation never settles, which is not a failed capture, so running
 * out of time returns a warning instead of throwing.
 */
async function waitForScreen(
  grab: () => Promise<Buffer | undefined>,
  same: (a: Buffer, b: Buffer) => boolean,
  before: Buffer | undefined,
  settle: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const deadline = Date.now() + parseDuration(settle);
  let previous: Buffer | undefined;
  let stableSince = Date.now();
  for (;;) {
    const frame = await grab();
    // A cancelled grab comes back empty, which must not read as a screen that never changed.
    signal?.throwIfAborted();
    const changed = frame && !(before && same(frame, before));
    if (frame && previous && same(frame, previous)) {
      if (changed && Date.now() - stableSince >= SETTLE_STABLE_MS) return undefined;
    } else {
      stableSince = Date.now();
    }
    previous = frame;
    if (Date.now() >= deadline) {
      return changed
        ? `the screen was still changing after ${settle}, so this capture may show a loading state`
        : `the screen did not change within ${settle} of opening the app, so this capture may not show it`;
    }
    await pause(SETTLE_POLL_MS, signal);
  }
}

/** One uncompressed frame, read straight from the device. */
function grabAndroidFrame(serialArgs: string[], signal?: AbortSignal): Promise<Buffer | undefined> {
  return new Promise((resolveP) => {
    if (signal?.aborted) {
      resolveP(undefined);
      return;
    }
    const child = spawn("adb", [...serialArgs, "exec-out", "screencap"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    // Cancelled: stop the capture; the caller sees the abort, not an empty frame.
    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveP(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const frame = Buffer.concat(chunks);
      resolveP(code === 0 && frame.length > 0 ? frame : undefined);
    });
  });
}

/**
 * Compares pixels with some tolerance: a still Android screen is not bit-identical,
 * because status bar icons flicker. Measured on a Galaxy Tab S7: a flicker changes
 * under 0.01% of pixels, opening an app changes nearly all of them.
 */
function sameAndroidFrame(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  const allowed = ((a.length - ANDROID_FRAME_HEADER) / 4) * ANDROID_FRAME_TOLERANCE;
  let different = 0;
  for (let i = ANDROID_FRAME_HEADER; i + 3 < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
      different += 1;
      if (different > allowed) return false;
    }
  }
  return true;
}

/** `adb shell` reports some failures only as text, with exit code 0. */
async function runAndroidOpen(
  what: string,
  args: string[],
  failure: RegExp,
  signal?: AbortSignal,
): Promise<void> {
  const result = await run("adb", args, { signal });
  const text = `${result.stdout}\n${result.stderr}`;
  const line = text.split("\n").find((l) => failure.test(l));
  if (result.exitCode !== 0 || line) {
    throw new Error(`${what} failed: ${(line ?? text).trim()}`);
  }
}

/** Stopping the adb client only signals the device, which then needs a moment to finish the file. */
async function waitForAndroidRecorderToExit(serialArgs: string[], signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + FINALIZE_GRACE_MS;
  while (Date.now() < deadline) {
    const { stdout } = await run("adb", [...serialArgs, "shell", "pidof", "screenrecord"], { signal });
    if (!stdout.trim()) return;
    await pause(SETTLE_POLL_MS, signal);
  }
  throw new Error(`adb screenrecord did not finish the recording within ${FINALIZE_GRACE_MS / 1000}s of being stopped`);
}

/** Process ids from `pidof`, which the device reports as text. */
async function androidRecorderPids(serialArgs: string[]): Promise<string[]> {
  const result = await run("adb", [...serialArgs, "shell", "pidof", "screenrecord"]).catch(() => undefined);
  return (result?.stdout ?? "").split(/\s+/).filter((pid) => /^\d+$/.test(pid));
}

/**
 * The same cleanup as `stopAndroidRecorder`, but started from the abort itself, as a separate
 * process that outlives this one. A cancelled run is reported as aborted at once and the CLI
 * exits right after, so the awaited cleanup may never get to run, and a recorder left on the
 * device keeps going (and keeps its file) until its time limit.
 */
function stopAndroidRecorderDetached(serialArgs: string[], remoteFile: string, recorder: boolean): void {
  const stop = recorder
    ? 'for s in -2 -9; do p=$(pidof screenrecord); [ -z "$p" ] && break; kill $s $p; sleep 2; done; '
    : "";
  try {
    const child = spawn("adb", [...serialArgs, "shell", `${stop}rm -f ${remoteFile}`], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the awaited cleanup still runs */
  }
}

/**
 * Stop the recorder on the device and delete its file. Stopping the adb client does not do
 * this: `screenrecord` keeps running (for up to its time limit) and keeps the file open.
 * Asks it to finish first (SIGINT), then kills it. Cleanup runs after a cancel, so nothing
 * here takes the abort signal.
 */
async function stopAndroidRecorder(serialArgs: string[], remoteFile: string): Promise<void> {
  for (const [signalArg, graceMs] of [["-2", 3_000], ["-9", 2_000]] as const) {
    const pids = await androidRecorderPids(serialArgs);
    if (pids.length === 0) break;
    await run("adb", [...serialArgs, "shell", "kill", signalArg, ...pids]).catch(() => {});
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && (await androidRecorderPids(serialArgs)).length > 0) {
      await pause(SETTLE_POLL_MS / 2);
    }
  }
  await run("adb", [...serialArgs, "shell", "rm", "-f", remoteFile]).catch(() => {});
}

async function captureAndroid(
  config: SimulatorConfig,
  opts: {
    artifactDir: string;
    fileSlug: string;
    capture: "video" | "screenshot";
    durationMs: number;
    signal?: AbortSignal | undefined;
  },
): Promise<SimulatorCapture> {
  const { signal } = opts;
  const serialArgs = config.device ? ["-s", config.device] : [];
  const settle = config.settle ?? DEFAULT_SETTLE;
  const opening = Boolean(config.app || config.deepLink);
  const before = opening ? await grabAndroidFrame(serialArgs, signal) : undefined;
  signal?.throwIfAborted();
  const open = async (): Promise<SimulatorCapture["warning"]> => {
    if (config.app) {
      await runAndroidOpen(
        `launch of "${config.app}"`,
        [...serialArgs, "shell", "monkey", "-p", config.app, "-c", "android.intent.category.LAUNCHER", "1"],
        /No activities found|monkey aborted/i,
        signal,
      );
    }
    if (config.deepLink) {
      await runAndroidOpen(
        `deep link "${config.deepLink}"`,
        [...serialArgs, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", config.deepLink],
        /^Error[: ]/,
        signal,
      );
    }
    return opening
      ? waitForScreen(() => grabAndroidFrame(serialArgs, signal), sameAndroidFrame, before, settle, signal)
      : undefined;
  };

  mkdirSync(opts.artifactDir, { recursive: true });
  if (opts.capture === "screenshot") {
    const warning = await open();
    const dest = join(opts.artifactDir, `${opts.fileSlug}.png`);
    const tmpRemote = "/sdcard/flowgraph-demo.png";
    const cleanDevice = (): void => stopAndroidRecorderDetached(serialArgs, tmpRemote, false);
    signal?.addEventListener("abort", cleanDevice, { once: true });
    try {
      await runStep("adb screencap", "adb", [...serialArgs, "shell", "screencap", "-p", tmpRemote], { signal });
      const pull = await run("adb", [...serialArgs, "pull", tmpRemote, dest], { signal });
      if (pull.exitCode !== 0) {
        throw new Error(`adb pull failed: ${pull.stderr.trim()}`);
      }
    } catch (err) {
      rmSync(dest, { force: true });
      throw err;
    } finally {
      // Whatever happened, including a cancel, the device is left as it was found.
      signal?.removeEventListener("abort", cleanDevice);
      await run("adb", [...serialArgs, "shell", "rm", "-f", tmpRemote]).catch(() => {});
    }
    return {
      path: dest,
      mimeType: "image/png",
      sizeBytes: assertNotEmpty(dest, "adb screencap"),
      ...(warning ? { warning } : {}),
    };
  }

  // Started before the app opens, so the clip shows it opening. The limit has to be set up
  // front and the wait for the screen has no fixed length, so allow for it and stop early.
  const dest = join(opts.artifactDir, `${opts.fileSlug}.mp4`);
  const tmpRemote = "/sdcard/flowgraph-demo.mp4";
  const wantedMs = opts.durationMs + (opening ? parseDuration(settle) + RECORDER_READY_MS + 10_000 : 0);
  const seconds = Math.max(1, Math.min(ANDROID_RECORD_LIMIT_SECONDS, Math.ceil(wantedMs / 1000)));
  const recorder = startRecording("adb", [...serialArgs, "shell", "screenrecord", "--time-limit", String(seconds), tmpRemote], signal);
  const cleanDevice = (): void => stopAndroidRecorderDetached(serialArgs, tmpRemote, true);
  signal?.addEventListener("abort", cleanDevice, { once: true });
  let warning: SimulatorCapture["warning"];
  try {
    if (opening) await recorder.ready;
    warning = await open();
    // Without an app to open, the limit ends the recording: the extra time is only a safety net.
    await recorder.runFor(opts.durationMs + (opening ? 0 : 5_000));
    await recorder.stop();
    await waitForAndroidRecorderToExit(serialArgs, signal);
  } catch (err) {
    // Stopping the adb client leaves `screenrecord` running on the device: stop it there too.
    await recorder.stop().catch(() => {});
    await stopAndroidRecorder(serialArgs, tmpRemote);
    signal?.removeEventListener("abort", cleanDevice);
    throw err;
  }
  signal?.removeEventListener("abort", cleanDevice);
  try {
    const pull = await run("adb", [...serialArgs, "pull", tmpRemote, dest], { signal });
    if (pull.exitCode !== 0) {
      throw new Error(`adb pull of screenrecord failed: ${pull.stderr.trim()}`);
    }
  } catch (err) {
    rmSync(dest, { force: true });
    throw err;
  } finally {
    await run("adb", [...serialArgs, "shell", "rm", "-f", tmpRemote]).catch(() => {});
  }
  return {
    path: dest,
    mimeType: "video/mp4",
    sizeBytes: assertNotEmpty(dest, "adb screenrecord"),
    ...(warning ? { warning } : {}),
  };
}

/** How long to wait for a recorder to report that it started, before moving on anyway. */
const RECORDER_READY_MS = 2_000;

type Recording = {
  /** Resolves once the recorder has said something, or after a short wait. */
  ready: Promise<void>;
  /** Wait this long, returning early (and throwing) if the recorder dies first. */
  runFor(ms: number): Promise<void>;
  /** Stop with SIGINT so the tool can finish the file, and wait for it. */
  stop(): Promise<void>;
};

/**
 * Exiting non-zero on its own is a failure. After our stop, the exit code means
 * little and the caller's file check decides.
 */
function startRecording(cmd: string, args: string[], signal?: AbortSignal): Recording {
  signal?.throwIfAborted();
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let stopping = false;
  let killed = false;
  let killer: NodeJS.Timeout | undefined;
  let markReady: () => void = () => {};
  // A cancel stops the recorder right away, from the abort itself: it finishes and exits on
  // its own even if this process does not stay to wait for it.
  signal?.addEventListener(
    "abort",
    () => {
      if (!stopping && child.exitCode === null && child.signalCode === null) {
        stopping = true;
        child.kill("SIGINT");
        killer = setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, FINALIZE_GRACE_MS);
      }
    },
    { once: true },
  );
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
    setTimeout(resolve, RECORDER_READY_MS).unref();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  child.stdout?.on("data", () => markReady());
  child.stderr?.on("data", (c: Buffer) => {
    stderr += String(c);
    markReady();
  });
  const finished = new Promise<void>((resolve, reject) => {
    child.on("error", (err) => {
      if (killer) clearTimeout(killer);
      markReady();
      reject(err);
    });
    child.on("close", (code) => {
      if (killer) clearTimeout(killer);
      markReady();
      if (killed) {
        reject(new Error(`${cmd} did not finish the recording within ${FINALIZE_GRACE_MS / 1000}s of being stopped`));
      } else if (code === 0 || stopping) {
        resolve();
      } else {
        reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
      }
    });
  });
  // A failure is reported by `runFor` or `stop`; until one of them runs, it must not crash the process.
  finished.catch(() => {});

  return {
    ready,
    async runFor(ms) {
      // A cancel ends the wait at once, rather than at the end of the recording.
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            timer = setTimeout(resolve, ms);
            onAbort = () => reject(signal?.reason);
            signal?.addEventListener("abort", onAbort, { once: true });
          }),
          finished,
        ]);
      } finally {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
    },
    async stop() {
      if (!stopping && child.exitCode === null && child.signalCode === null) {
        stopping = true;
        child.kill("SIGINT");
        killer = setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, FINALIZE_GRACE_MS);
      }
      await finished;
    },
  };
}
