/**
 * Process-scoped registry for long-running background services started by
 * `service` nodes. Services are keyed by (threadId, name), survive HITL
 * pauses within the same process, and are torn down when a run reaches a
 * terminal state (completed/error) unless keepAlive is set.
 *
 * A process.exit safety net SIGKILLs any still-tracked children so a Ctrl-C
 * does not orphan vite/dev-server processes.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import { normalizeShellText } from "../nodes/shell.js";
import { performHttpRequest } from "../nodes/http-request.js";
import { parseDuration, sleep } from "./duration.js";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_INTERVAL_MS = 300;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const MAX_LOG_BUFFER = 1 * 1024 * 1024; // 1 MiB combined

export type ServiceReady =
  | { port: number }
  | { url: string; status?: number[] }
  | { log: string };

export interface ServiceStartSpec {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  ready?: ServiceReady;
  readyTimeout?: string;
  readyInterval?: string;
  stopSignal?: string;
  stopTimeout?: string;
  keepAlive?: boolean;
  signal?: AbortSignal;
}

export type ServiceStatusValue = "running" | "stopped" | "not_found";

export interface ServiceInfo {
  name: string;
  status: ServiceStatusValue;
  pid?: number;
  port?: number;
  url?: string;
  startedAt?: string;
  stoppedAt?: string;
  keepAlive: boolean;
  exitCode?: number | null;
}

interface TrackedService {
  name: string;
  threadId: string;
  child: ChildProcess;
  keepAlive: boolean;
  startedAt: string;
  stoppedAt?: string;
  port?: number;
  url?: string;
  stopSignal: NodeJS.Signals;
  stopTimeoutMs: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  exited: boolean;
}

const services = new Map<string, TrackedService>();
let exitHookInstalled = false;

/** Resolve the service-registry thread key from a node/tool run context. */
export function threadIdOf(ctx: { meta: { threadId?: string | undefined; runId: string } }): string {
  return ctx.meta.threadId ?? ctx.meta.runId;
}

function serviceKey(threadId: string, name: string): string {
  return `${threadId}\0${name}`;
}

function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const svc of services.values()) {
      if (!svc.exited && svc.child.pid) {
        try {
          svc.child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  });
}

function toInfo(svc: TrackedService): ServiceInfo {
  const running = !svc.exited && svc.child.exitCode === null && !svc.child.killed;
  return {
    name: svc.name,
    status: running ? "running" : "stopped",
    ...(svc.child.pid != null ? { pid: svc.child.pid } : {}),
    ...(svc.port != null ? { port: svc.port } : {}),
    ...(svc.url != null ? { url: svc.url } : {}),
    startedAt: svc.startedAt,
    ...(svc.stoppedAt != null ? { stoppedAt: svc.stoppedAt } : {}),
    keepAlive: svc.keepAlive,
    ...(svc.exitCode != null ? { exitCode: svc.exitCode } : {}),
  };
}

async function waitForPort(port: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", () => {
      socket.destroy();
      reject(new Error(`port ${port} not ready`));
    });
    signal?.addEventListener(
      "abort",
      () => {
        socket.destroy();
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });
}

async function waitForUrl(
  url: string,
  allowedStatus: number[] | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const result = await performHttpRequest({
    method: "GET",
    url,
    expectStatus: "any",
    signal: signal ?? null,
  });
  const allowed = allowedStatus ?? [200, 201, 202, 204];
  if (!allowed.includes(result.status)) {
    throw new Error(`url ${url} returned ${result.status}`);
  }
}

function waitForLog(svc: TrackedService, pattern: string): void {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    throw new Error(
      `service "${svc.name}": invalid ready.log regex: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const combined = svc.stdout + svc.stderr;
  if (!re.test(combined)) {
    throw new Error(`log pattern /${pattern}/ not matched yet`);
  }
}

async function pollReady(
  svc: TrackedService,
  ready: ServiceReady,
  timeoutMs: number,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Aborted");
    }
    if (svc.exited) {
      const excerpt = (svc.stderr || svc.stdout).trim().slice(0, 500);
      throw new Error(
        `service "${svc.name}" exited before becoming ready` +
          (excerpt ? `: ${excerpt}` : ""),
      );
    }

    try {
      if ("port" in ready) {
        await waitForPort(ready.port, signal);
        svc.port = ready.port;
        return;
      }
      if ("url" in ready) {
        await waitForUrl(ready.url, ready.status, signal);
        svc.url = ready.url;
        return;
      }
      if ("log" in ready) {
        waitForLog(svc, ready.log);
        return;
      }
    } catch (err) {
      lastErr = err;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining), signal);
  }

  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "timeout");
  throw new Error(
    `service "${svc.name}" did not become ready within ${timeoutMs}ms (${detail})`,
  );
}

function attachStreams(svc: TrackedService): void {
  svc.child.stdout?.on("data", (chunk: Buffer | string) => {
    svc.stdout += String(chunk);
    if (svc.stdout.length > MAX_LOG_BUFFER) {
      svc.stdout = svc.stdout.slice(-MAX_LOG_BUFFER);
    }
  });
  svc.child.stderr?.on("data", (chunk: Buffer | string) => {
    svc.stderr += String(chunk);
    if (svc.stderr.length > MAX_LOG_BUFFER) {
      svc.stderr = svc.stderr.slice(-MAX_LOG_BUFFER);
    }
  });
  svc.child.on("close", (code) => {
    svc.exited = true;
    svc.exitCode = code;
    svc.stoppedAt = new Date().toISOString();
  });
  svc.child.on("error", () => {
    svc.exited = true;
    svc.stoppedAt = new Date().toISOString();
  });
}

export async function startService(
  threadId: string,
  spec: ServiceStartSpec,
): Promise<ServiceInfo> {
  ensureExitHook();

  const key = serviceKey(threadId, spec.name);
  const existing = services.get(key);
  if (existing && !existing.exited) {
    return toInfo(existing);
  }
  // Stale entry from a prior exited process — drop it before re-start.
  if (existing) services.delete(key);

  const command = normalizeShellText(spec.command);
  const args = spec.args?.map((a) => normalizeShellText(a));
  const useShell = args === undefined;
  const cwd = spec.cwd;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(spec.env
      ? Object.fromEntries(
          Object.entries(spec.env).map(([k, v]) => [k, normalizeShellText(String(v))]),
        )
      : {}),
  };

  const child = useShell
    ? spawn(command, { shell: true, cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(command, args ?? [], {
        shell: false,
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

  const stopSignal = (spec.stopSignal?.trim() || "SIGTERM") as NodeJS.Signals;
  const stopTimeoutMs = spec.stopTimeout
    ? parseDuration(spec.stopTimeout)
    : DEFAULT_STOP_TIMEOUT_MS;

  const svc: TrackedService = {
    name: spec.name,
    threadId,
    child,
    keepAlive: Boolean(spec.keepAlive),
    startedAt: new Date().toISOString(),
    stopSignal,
    stopTimeoutMs,
    stdout: "",
    stderr: "",
    exitCode: null,
    exited: false,
  };

  if ("port" in (spec.ready ?? {})) {
    svc.port = (spec.ready as { port: number }).port;
  }
  if ("url" in (spec.ready ?? {})) {
    svc.url = (spec.ready as { url: string }).url;
  }

  attachStreams(svc);
  services.set(key, svc);

  // Bail early if spawn failed immediately.
  await sleep(0);
  if (svc.exited && svc.child.pid == null) {
    services.delete(key);
    const excerpt = (svc.stderr || svc.stdout).trim().slice(0, 500);
    throw new Error(
      `service "${spec.name}" failed to start` + (excerpt ? `: ${excerpt}` : ""),
    );
  }

  if (spec.ready) {
    const timeoutMs = spec.readyTimeout
      ? parseDuration(spec.readyTimeout)
      : DEFAULT_READY_TIMEOUT_MS;
    const intervalMs = spec.readyInterval
      ? parseDuration(spec.readyInterval)
      : DEFAULT_READY_INTERVAL_MS;
    try {
      await pollReady(svc, spec.ready, timeoutMs, intervalMs, spec.signal);
    } catch (err) {
      // Failed readiness — kill and untrack so retries can re-start cleanly.
      await stopTracked(svc, { force: true });
      services.delete(key);
      throw err;
    }
  }

  return toInfo(svc);
}

async function stopTracked(
  svc: TrackedService,
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  if (svc.exited) return;

  const sig = opts.force ? "SIGKILL" : svc.stopSignal;
  try {
    svc.child.kill(sig);
  } catch {
    /* already gone */
  }

  if (opts.force) {
    // Give the event loop a tick to observe the kill.
    await sleep(0);
    return;
  }

  const timeoutMs = svc.stopTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  while (!svc.exited && Date.now() < deadline) {
    if (opts.signal?.aborted) break;
    try {
      await sleep(Math.min(50, Math.max(0, deadline - Date.now())), opts.signal);
    } catch {
      break;
    }
  }

  if (!svc.exited) {
    try {
      svc.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    await sleep(0);
  }
}

export async function stopService(
  threadId: string,
  name: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ServiceInfo> {
  const key = serviceKey(threadId, name);
  const svc = services.get(key);
  if (!svc) {
    return { name, status: "not_found", keepAlive: false };
  }
  await stopTracked(svc, opts.signal ? { signal: opts.signal } : {});
  services.delete(key);
  return toInfo(svc);
}

export function statusService(threadId: string, name: string): ServiceInfo {
  const svc = services.get(serviceKey(threadId, name));
  if (!svc) return { name, status: "not_found", keepAlive: false };
  return toInfo(svc);
}

export async function restartService(
  threadId: string,
  spec: ServiceStartSpec,
): Promise<ServiceInfo> {
  await stopService(threadId, spec.name, spec.signal ? { signal: spec.signal } : {});
  return startService(threadId, spec);
}

/**
 * Stop every non-keepAlive service for a thread.
 * Pass `force: true` to also stop keepAlive services (used by process exit / tests).
 */
export async function terminateThreadServices(
  threadId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const toStop: TrackedService[] = [];
  for (const [key, svc] of services) {
    if (svc.threadId !== threadId) continue;
    if (!opts.force && svc.keepAlive) continue;
    toStop.push(svc);
    services.delete(key);
  }
  await Promise.all(
    toStop.map((svc) => stopTracked(svc, opts.force ? { force: true } : {})),
  );
}

/** Test helper: clear the registry and kill remaining children. */
export async function resetServiceManager(): Promise<void> {
  const all = [...services.values()];
  services.clear();
  await Promise.all(all.map((svc) => stopTracked(svc, { force: true })));
}

/** Test helper: list tracked services for a thread. */
export function listThreadServices(threadId: string): ServiceInfo[] {
  const out: ServiceInfo[] = [];
  for (const svc of services.values()) {
    if (svc.threadId === threadId) out.push(toInfo(svc));
  }
  return out;
}
