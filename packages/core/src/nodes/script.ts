/**
 * Built-in node type: `script`
 *
 * Runs inline Node.js (ESM) source in a sandboxed child process using
 * Node's built-in permission model (`--permission`). Engine bookkeeping
 * lives in an isolated temp directory; the child process `cwd` defaults to
 * the graph workspace so relative paths match `shell` / `demo` / `service`.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { ScriptWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { parseDuration } from "../runtime/duration.js";
import { applyOutput } from "./output.js";

const configSchema = ScriptWithSchema;
type Config = z.infer<typeof configSchema>;

const DEFAULT_TIMEOUT_MS = 30_000;
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

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      // Minimal env — do not inherit host process.env (avoids leaking secrets).
      // Authors opt secrets in via with.env templates.
      PATH: process.env.PATH,
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
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const durationMs = Date.now() - started;

    if (exitCode !== 0) {
      const excerpt = stderr.trim().slice(0, STDERR_EXCERPT) || stdout.trim().slice(0, STDERR_EXCERPT);
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

function resolvePermissionPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Path may not exist yet (e.g. a file the script will create).
    return p;
  }
}

/** Resolve a permission grant against the graph workspace when relative. */
function resolveGrantPath(p: string, workspace?: string): string {
  if (isAbsolute(p) || !workspace) return p;
  return resolve(workspace, p);
}

/**
 * Node's permission model treats a path with a trailing `/` as a directory
 * grant (covers all children). Without it, only that exact path is allowed.
 *
 * Returns one or two grants: the path as given, plus its realpath when they
 * differ (macOS `/tmp` → `/private/var/folders/…`). Node's permission check
 * does not always follow symlinks for the *operation* path, so both forms
 * must be allowed for author-facing paths to work reliably.
 */
function normalizePermissionGrant(raw: string): string {
  if (raw.endsWith("/") || raw.endsWith("\\")) return raw;
  try {
    if (statSync(raw).isDirectory()) return `${raw}/`;
  } catch {
    if (!/\.[A-Za-z0-9]+$/.test(raw)) return `${raw}/`;
  }
  return raw;
}

function asPermissionGrants(p: string, workspace?: string): string[] {
  const absolute = resolveGrantPath(p, workspace);
  const original = normalizePermissionGrant(absolute);
  const resolved = normalizePermissionGrant(resolvePermissionPath(absolute));
  const grants = original === resolved ? [original] : [original, resolved];

  // Creating a path that does not exist yet requires write access on its parent
  // (e.g. fsWrite: ["outputs"] → mkdir("outputs") needs write on the workspace).
  if (!existsSync(absolute)) {
    const parent = dirname(absolute);
    if (parent && parent !== absolute) {
      const parentOrig = normalizePermissionGrant(parent);
      const parentResolved = normalizePermissionGrant(resolvePermissionPath(parent));
      grants.push(parentOrig);
      if (parentResolved !== parentOrig) grants.push(parentResolved);
    }
  }

  return [...new Set(grants)];
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
  capabilities: { sideEffecting: true },

  build(_ctx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    return {
      contract: {},
      capabilities: { sideEffecting: true },

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const scope = {
          state,
          input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
          config: ctx.config,
          run: ctx.meta,
        };

        const input = config.input
          ? (renderDeep(config.input, scope) as Record<string, unknown>)
          : {};
        const renderedEnvRaw = config.env
          ? (renderDeep(config.env, scope) as Record<string, string>)
          : undefined;
        const env = renderedEnvRaw
          ? Object.fromEntries(
              Object.entries(renderedEnvRaw).map(([k, v]) => [k, String(v)]),
            )
          : undefined;

        const timeoutMs = config.timeout ? parseDuration(config.timeout) : DEFAULT_TIMEOUT_MS;
        const permissions = normalizeScriptPermissions(config.permissions);

        ctx.logger.debug("script exec", {
          timeoutMs,
          permissions,
          codeLength: config.code.length,
        });

        const { result, stdout, stderr, exitCode, durationMs } = await runScriptSandboxed(
          config.code,
          {
            input,
            ...(env ? { env } : {}),
            timeoutMs,
            ...(permissions ? { permissions } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            workspace: ctx.workspace,
            nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
            runId: String(ctx.meta?.runId ?? ""),
            threadId: String(ctx.meta?.threadId ?? ""),
          },
        );

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

function runProcess(opts: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { command, args, cwd, env, timeoutMs, signal } = opts;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }

    const child = spawn(command, args, {
      shell: false,
      cwd,
      env,
      signal,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (err?: Error, exitCode = 1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
        return;
      }
      if (timedOut) {
        reject(new Error(`script: timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
      if (stdout.length > MAX_BUFFER) {
        child.kill("SIGKILL");
        finish(new Error(`script: stdout exceeded maxBuffer (${MAX_BUFFER} bytes)`));
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > MAX_BUFFER) {
        child.kill("SIGKILL");
        finish(new Error(`script: stderr exceeded maxBuffer (${MAX_BUFFER} bytes)`));
      }
    });

    child.on("error", (err) => finish(err));
    child.on("close", (code) => finish(undefined, code ?? 1));
    child.stdin?.end();
  });
}
