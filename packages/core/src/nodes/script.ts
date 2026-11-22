/**
 * Built-in node type: `script`
 *
 * Runs inline or file-based Node.js (ESM) source in a sandboxed child process using
 * Node's built-in permission model (`--permission`). Engine bookkeeping
 * lives in an isolated temp directory; the child process `cwd` defaults to
 * the graph workspace so relative paths match `shell` / `demo` / `service`.
 */

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { ScriptWithSchema } from "@flowgraph/spec";
import { renderDeep } from "@flowgraph/expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { assertHostProbeAllowed, assertScriptFileAllowed, nodePolicyOf } from "../node-policy.js";
import { applyOutput } from "./output.js";
import { secretScope } from "../runtime/secret-scope.js";
import { findMissingBins, missingToolIssue } from "../runtime/requires.js";
import { DEFAULT_INHERITED_ENV, pickHostEnv } from "../runtime/child-env.js";

const configSchema = ScriptWithSchema;
type Config = z.infer<typeof configSchema>;

const MAX_BUFFER = 10 * 1024 * 1024;
const STDERR_EXCERPT = 500;

export type ScriptPermissions = {
  fsRead?: string[];
  fsWrite?: string[];
  childProcess?: boolean;
  workerThreads?: boolean;
};

export type RunScriptSandboxedOptions = {
  input?: unknown;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** How long a stop waits for the direct child before SIGKILL. Defaults to 2s. */
  stopGraceMs?: number;
  permissions?: ScriptPermissions;
  signal?: AbortSignal;
  /**
   * Graph workspace directory. When set, the child process `cwd` is this
   * path (so relative writes like `outputs/foo.md` land next to the graph)
   * and relative `permissions.fsRead` / `fsWrite` grants resolve against it.
   * Defaults to the ephemeral sandbox temp dir when omitted.
   */
  workspace?: string;
  /** Metadata exposed to the script as `ctx`. */
  nodeId?: string;
  runId?: string;
  threadId?: string;
};

export type RunScriptSandboxedResult = {
  result: unknown;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

/**
 * Execute inline Node.js ESM source in a permission-locked child process.
 * Shared by the `script` node and the desktop sidecar's ScriptRun RPC.
 */
export async function runScriptSandboxed(
  code: string,
  options: RunScriptSandboxedOptions = {},
): Promise<RunScriptSandboxedResult> {
  if (!code.trim()) {
    throw new Error("script: code is empty");
  }

  const timeoutMs = options.timeoutMs;
  // Resolve symlinks (e.g. macOS /tmp → /private/var/folders/…) so Node's
  // permission model can realpath the entry script without needing /var.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fg-script-")));
  const scriptPath = join(dir, "script.mjs");
  const entryPath = join(dir, "entry.mjs");
  const resultPath = join(dir, "result.json");
  const started = Date.now();

  try {
    writeFileSync(scriptPath, code, "utf8");
    writeFileSync(entryPath, ENTRY_SOURCE, "utf8");

    const workspace = options.workspace?.trim() || undefined;
    const nodeArgs = buildPermissionArgs(dir, options.permissions, workspace);
    nodeArgs.push(entryPath);

    const env: NodeJS.ProcessEnv = {
      // Minimal env — operational defaults only; authors opt secrets in via with.env.
      ...pickHostEnv(DEFAULT_INHERITED_ENV),
      FLOWGRAPH_INPUT: JSON.stringify(options.input ?? {}),
      FLOWGRAPH_RESULT_PATH: resultPath,
      FLOWGRAPH_NODE_ID: options.nodeId ?? "",
      FLOWGRAPH_RUN_ID: options.runId ?? "",
      FLOWGRAPH_THREAD_ID: options.threadId ?? "",
      ...(options.env ?? {}),
    };

    // Prefer the graph workspace as cwd so relative paths match other node types.
    // Engine entry/script/result files stay under `dir` via absolute paths.
    const cwd = workspace ?? dir;

    const { stdout, stderr, exitCode } = await runProcess({
      command: process.execPath,
      args: nodeArgs,
      cwd,
      env,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(options.stopGraceMs !== undefined ? { stopGraceMs: options.stopGraceMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const durationMs = Date.now() - started;

    if (exitCode !== 0) {
      const lines=stderr.trim().split("\n");
      const excerpt=(lines.find(line=>/^(?:\w*Error|error):/.test(line.trim())) ?? lines.filter(line=>!/^\s+at /.test(line)).slice(0,3).join(" ")).slice(0,STDERR_EXCERPT) || stdout.trim().slice(0,STDERR_EXCERPT);
      throw new Error(
        `script: process exited with code ${exitCode}` + (excerpt ? `: ${excerpt}` : ""),
      );
    }

    let result: unknown;
    try {
      const raw = readFileSync(resultPath, "utf8");
      result = JSON.parse(raw) as unknown;
    } catch (err) {
      const excerpt = stderr.trim().slice(0, STDERR_EXCERPT);
      throw new Error(
        `script: failed to read result file` +
          (err instanceof Error ? `: ${err.message}` : "") +
          (excerpt ? ` (stderr: ${excerpt})` : ""),
      );
    }

    return { result, stdout, stderr, exitCode, durationMs };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

/** Strip Zod's `| undefined` optional fields for exactOptionalPropertyTypes. */
function normalizeScriptPermissions(
  p: Config["permissions"],
): ScriptPermissions | undefined {
  if (!p) return undefined;
  const out: ScriptPermissions = {};
  if (p.fsRead) out.fsRead = [...p.fsRead];
  if (p.fsWrite) out.fsWrite = [...p.fsWrite];
  if (p.childProcess === true) out.childProcess = true;
  if (p.workerThreads === true) out.workerThreads = true;
  return Object.keys(out).length ? out : undefined;
}

/** The realpath of `p`, or of its nearest existing ancestor with the rest appended. */
function resolvePermissionPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return join(resolvePermissionPath(parent), basename(p));
  }
}

/** Resolve a permission grant against the graph workspace when relative. */
function resolveGrantPath(p: string, workspace?: string): string {
  if (isAbsolute(p) || !workspace) return p;
  return resolve(workspace, p);
}

/**
 * Node's permission model treats an existing directory (with or without a
 * trailing `/`) as covering its children; any other path is allowed exactly.
 * A directory that does not exist yet is only covered through `dir/*`.
 *
 * A path that does not exist and has no file extension is taken as a
 * directory the script may create: the exact path (so `mkdir` or a file of
 * that name works) plus `path/*`. Nothing outside the named path is granted,
 * so a file in a folder that does not exist yet needs a grant on the folder.
 *
 * Grants are returned for the path as given and for its realpath when they
 * differ (macOS `/tmp` → `/private/var/folders/…`). Node's permission check
 * does not always follow symlinks for the *operation* path, so both forms
 * must be allowed for author-facing paths to work reliably.
 */
function normalizePermissionGrants(raw: string): string[] {
  const bare = raw.replace(/[\\/]+$/, "") || raw;
  let isDirectory: boolean;
  try {
    isDirectory = statSync(bare).isDirectory();
  } catch {
    if (raw !== bare || !/\.[A-Za-z0-9]+$/.test(bare)) return [bare, join(bare, "*")];
    return [bare];
  }
  return [isDirectory && !bare.endsWith("/") ? `${bare}/` : bare];
}

function asPermissionGrants(p: string, workspace?: string): string[] {
  const absolute = resolveGrantPath(p, workspace);
  // `resolve` and `realpath` drop a trailing `/`, which marks a directory grant.
  const asWritten = (q: string) => (/[\\/]$/.test(p) && !/[\\/]$/.test(q) ? `${q}/` : q);
  return [
    ...new Set([
      ...normalizePermissionGrants(asWritten(absolute)),
      ...normalizePermissionGrants(asWritten(resolvePermissionPath(absolute))),
    ]),
  ];
}

function buildPermissionArgs(
  tmpdirPath: string,
  permissions?: ScriptPermissions,
  workspace?: string,
): string[] {
  const sandbox = tmpdirPath.endsWith("/") ? tmpdirPath : `${tmpdirPath}/`;
  const args = ["--permission", `--allow-fs-read=${sandbox}`, `--allow-fs-write=${sandbox}`];

  for (const p of permissions?.fsRead ?? []) {
    if (!p) continue;
    for (const g of asPermissionGrants(p, workspace)) args.push(`--allow-fs-read=${g}`);
  }
  for (const p of permissions?.fsWrite ?? []) {
    if (!p) continue;
    for (const g of asPermissionGrants(p, workspace)) args.push(`--allow-fs-write=${g}`);
  }
  if (permissions?.childProcess) {
    args.push("--allow-child-process");
  }
  if (permissions?.workerThreads) {
    args.push("--allow-worker");
  }
  return args;
}

/** Engine-generated entry that loads the user script and writes its return value. */
const ENTRY_SOURCE = `\
import { writeFileSync } from "node:fs";
import fn from "./script.mjs";

const input = JSON.parse(process.env.FLOWGRAPH_INPUT ?? "{}");
const ctx = {
  nodeId: process.env.FLOWGRAPH_NODE_ID ?? "",
  runId: process.env.FLOWGRAPH_RUN_ID ?? "",
  threadId: process.env.FLOWGRAPH_THREAD_ID ?? "",
};

if (typeof fn !== "function") {
  console.error("script: default export must be a function, got " + typeof fn);
  process.exit(1);
}

try {
  const result = await fn(input, ctx);
  writeFileSync(process.env.FLOWGRAPH_RESULT_PATH, JSON.stringify(result ?? null), "utf8");
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
}
`;

export const scriptNode = defineNode<Config>({
  type: "script",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: { sideEffecting: true, stopsOnTimeout: true },

  build(_ctx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    return {
      contract: {},
      capabilities: { sideEffecting: true, stopsOnTimeout: true },

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const scope = {
          state,
          input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
          config: ctx.config,
          run: ctx.meta,
          secret: secretScope(ctx),
        };

        const input = scope.input;
        const renderedEnvRaw = config.env
          ? (renderDeep(config.env, scope) as Record<string, string>)
          : undefined;
        const env = renderedEnvRaw
          ? Object.fromEntries(
              Object.entries(renderedEnvRaw).map(([k, v]) => [k, String(v)]),
            )
          : undefined;

        const permissions = normalizeScriptPermissions(config.permissions);
        let code = config.code;
        if (config.file !== undefined) {
          assertScriptFileAllowed(nodePolicyOf(ctx), `script node "${ctx.nodeId}"`);
          const file = resolve(ctx.config.graphDir ?? ctx.workspace, config.file);
          try {
            code = readFileSync(file, "utf8");
            if (!code.trim()) throw new Error("source file is empty");
          } catch (cause) {
            throw new Error(`script node "${ctx.nodeId}" could not load "${file}": ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
          }
        }
        if (code === undefined) throw new Error(`script node "${ctx.nodeId}": provide exactly one of code or file`);

        assertHostProbeAllowed(nodePolicyOf(ctx), config.requires, `script node "${ctx.nodeId}"`);
        const missing = await findMissingBins(config.requires);
        if (missing.length > 0) {
          const skip = config.onMissingTool === "skip";
          ctx.issue(missingToolIssue(missing, { command: "script", skipped: skip }));
          if (skip) {
            const result = {
              ok: false,
              skipped: true,
              missing: missing.map((m) => m.bin),
            };
            ctx.emit("node.output", result);
            return {
              update: applyOutput(config.output, result, {
                nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
                scope,
              }),
            };
          }
          throw new Error(missingToolIssue(missing, { command: "script", skipped: false }).message);
        }

        ctx.logger.debug("script exec", {
          permissions,
          codeLength: code.length,
        });

        const { result, stdout, stderr, exitCode, durationMs } = await runScriptSandboxed(
          code,
          {
            input,
            ...(env ? { env } : {}),
            ...(permissions ? { permissions } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            workspace: ctx.workspace,
            nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
            runId: String(ctx.meta?.runId ?? ""),
            threadId: String(ctx.meta?.threadId ?? ""),
          },
        ).catch(err=>{
          const error=err instanceof Error?err:new Error(String(err));
          error.message=`script node "${ctx.nodeId}": ${error.message}`;
          if (/Illegal return statement|default.*function|default.*export|export.*default/i.test(error.message)) error.message += ". Scripts are ESM modules; use export default async (input, ctx) => { ... }.";
          throw error;
        });

        ctx.emit("node.output", {
          result,
          stdout,
          stderr,
          exitCode,
          durationMs,
        });

        return {
          update: applyOutput(config.output, result, {
            nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
            scope,
          }),
        };
      },
    };
  },
});

/**
 * After SIGTERM, SIGKILL the process group. If the direct child is still
 * running, wait this long so it can exit on its own. If it has already
 * closed, SIGKILL immediately so a grandchild that ignores SIGTERM is not
 * left reparented to init.
 */
const DEFAULT_STOP_GRACE_MS = 2_000;

function runProcess(opts: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stopGraceMs?: number;
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { command, args, cwd, env, timeoutMs, signal } = opts;
  const stopGraceMs = opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }

    // A new process group so a timeout or abort reaches grandchildren, including
    // a script that traps SIGTERM. Windows has no POSIX process groups.
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, {
      shell: false,
      cwd,
      env,
      detached: grouped,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let stopReason: Error | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closeResult: { err?: Error; exitCode: number } | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      const pid = child.pid;
      if (grouped && pid !== undefined) {
        try {
          process.kill(-pid, sig);
          return;
        } catch {
          // The group has already exited.
        }
      }
      try { child.kill(sig); } catch { /* already exited */ }
    };

    const settle = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      signal?.removeEventListener("abort", onAbort);
      if (stopReason) {
        reject(stopReason);
        return;
      }
      if (closeResult?.err) {
        reject(closeResult.err);
        return;
      }
      resolve({ stdout, stderr, exitCode: closeResult?.exitCode ?? 1 });
    };

    const finishStop = () => {
      if (grace) clearTimeout(grace);
      grace = undefined;
      killGroup("SIGKILL");
      settle();
    };

    // Wait out the grace only while the direct child is still running.
    const requestStop = (reason: Error) => {
      if (stopReason) return;
      stopReason = reason;
      killGroup("SIGTERM");
      if (settled) return;
      if (closeResult) {
        finishStop();
        return;
      }
      grace = setTimeout(finishStop, stopGraceMs);
    };

    const onAbort = () => {
      const reason = signal?.reason;
      requestStop(reason instanceof Error ? reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        requestStop(new Error(`script: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    const noteClose = (err?: Error, exitCode = 1) => {
      if (!closeResult?.err) closeResult = { ...(err ? { err } : {}), exitCode };
      if (!stopReason) {
        settle();
        return;
      }
      finishStop();
    };

    const overflow = (which: "stdout" | "stderr") => {
      if (stopReason) return;
      stopReason = new Error(`script: ${which} exceeded maxBuffer (${MAX_BUFFER} bytes)`);
      killGroup("SIGKILL");
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
      if (stdout.length > MAX_BUFFER) overflow("stdout");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > MAX_BUFFER) overflow("stderr");
    });

    child.on("error", (err) => noteClose(err));
    child.on("close", (code) => noteClose(undefined, code ?? 1));
    child.stdin?.end();
  });
}
