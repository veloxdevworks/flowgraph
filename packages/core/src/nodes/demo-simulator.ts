/**
 * Mobile-simulator capture for the `demo` node (iOS via simctl, Android via adb).
 * Best-effort: missing toolchains throw so the demo node can degrade.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
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
};

export type SimulatorCapture = {
  path: string;
  mimeType: string;
  sizeBytes: number;
};

function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, opts.timeoutMs ?? 60_000);
    child.stdout?.on("data", (c: Buffer) => { stdout += String(c); });
    child.stderr?.on("data", (c: Buffer) => { stderr += String(c); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

export async function captureSimulator(
  config: SimulatorConfig,
  opts: { artifactDir: string; fileSlug: string },
): Promise<SimulatorCapture> {
  const capture = config.capture ?? "video";
  const durationMs = config.duration ? parseDuration(config.duration) : 10_000;

  if (config.platform === "ios") {
    if (!(await checkBinOnPath("xcrun"))) {
      throw new Error("xcrun is not installed. Install Xcode command-line tools (`xcode-select --install`).");
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
  },
): Promise<SimulatorCapture> {
  const device = config.device?.trim();
  if (device) {
    await run("xcrun", ["simctl", "boot", device]).catch(() => {
      /* already booted */
    });
  }
  if (config.app) {
    await run("xcrun", ["simctl", "launch", device || "booted", config.app]);
  }
  if (config.deepLink) {
    await run("xcrun", ["simctl", "openurl", device || "booted", config.deepLink]);
  }

  mkdirSync(opts.artifactDir, { recursive: true });
  if (opts.capture === "screenshot") {
    const dest = join(opts.artifactDir, `${opts.fileSlug}.png`);
    const result = await run("xcrun", ["simctl", "io", device || "booted", "screenshot", dest]);
    if (result.exitCode !== 0 || !existsSync(dest)) {
      throw new Error(`simctl screenshot failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return { path: dest, mimeType: "image/png", sizeBytes: statSync(dest).size };
  }

  const dest = join(opts.artifactDir, `${opts.fileSlug}.mp4`);
  await recordWithTimeout(
    "xcrun",
    ["simctl", "io", device || "booted", "recordVideo", "--codec=h264", dest],
    opts.durationMs,
  );
  if (!existsSync(dest)) {
    throw new Error("simctl recordVideo did not produce a file");
  }
  return { path: dest, mimeType: "video/mp4", sizeBytes: statSync(dest).size };
}

async function captureAndroid(
  config: SimulatorConfig,
  opts: {
    artifactDir: string;
    fileSlug: string;
    capture: "video" | "screenshot";
    durationMs: number;
  },
): Promise<SimulatorCapture> {
  const serialArgs = config.device ? ["-s", config.device] : [];
  if (config.app) {
    await run("adb", [...serialArgs, "shell", "monkey", "-p", config.app, "-c", "android.intent.category.LAUNCHER", "1"]);
  }
  if (config.deepLink) {
    await run("adb", [...serialArgs, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", config.deepLink]);
  }

  mkdirSync(opts.artifactDir, { recursive: true });
  if (opts.capture === "screenshot") {
    const dest = join(opts.artifactDir, `${opts.fileSlug}.png`);
    const tmpRemote = "/sdcard/flowgraph-demo.png";
    const cap = await run("adb", [...serialArgs, "shell", "screencap", "-p", tmpRemote]);
    if (cap.exitCode !== 0) {
      throw new Error(`adb screencap failed: ${cap.stderr.trim()}`);
    }
    const pull = await run("adb", [...serialArgs, "pull", tmpRemote, dest]);
    await run("adb", [...serialArgs, "shell", "rm", "-f", tmpRemote]).catch(() => {});
    if (pull.exitCode !== 0 || !existsSync(dest)) {
      throw new Error(`adb pull failed: ${pull.stderr.trim()}`);
    }
    return { path: dest, mimeType: "image/png", sizeBytes: statSync(dest).size };
  }

  const dest = join(opts.artifactDir, `${opts.fileSlug}.mp4`);
  const tmpRemote = "/sdcard/flowgraph-demo.mp4";
  const seconds = Math.max(1, Math.min(180, Math.ceil(opts.durationMs / 1000)));
  await recordWithTimeout(
    "adb",
    [...serialArgs, "shell", "screenrecord", "--time-limit", String(seconds), tmpRemote],
    opts.durationMs + 5_000,
  );
  const pull = await run("adb", [...serialArgs, "pull", tmpRemote, dest]);
  await run("adb", [...serialArgs, "shell", "rm", "-f", tmpRemote]).catch(() => {});
  if (pull.exitCode !== 0 || !existsSync(dest)) {
    throw new Error(`adb pull of screenrecord failed: ${pull.stderr.trim()}`);
  }
  return { path: dest, mimeType: "video/mp4", sizeBytes: statSync(dest).size };
}

function recordWithTimeout(cmd: string, args: string[], durationMs: number): Promise<void> {
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => { stderr += String(c); });
    const stopper = setTimeout(() => {
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, durationMs);
    child.on("error", (err) => {
      clearTimeout(stopper);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(stopper);
      if (code === 0 || code === 130 || code === 255 || code === 1) {
        resolveP();
        return;
      }
      reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
    });
  });
}
