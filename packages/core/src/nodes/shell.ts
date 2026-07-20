/**
 * Built-in node type: `shell`
 *
 * Runs a local command. When `args` is set, uses execFile (no shell, argv-safe).
 * When `args` is omitted, runs `command` through the OS shell (pipes / && / globs).
 */

import { spawn } from "node:child_process";
import { z } from "zod";
import { ShellWithSchema } from "@veloxdevworks/flowgraph-spec";
import { renderDeep } from "@veloxdevworks/flowgraph-expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { parseDuration } from "../runtime/duration.js";
import { applyOutput } from "./output.js";

const configSchema = ShellWithSchema;
type Config = z.infer<typeof configSchema>;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * macOS / rich-text editors often insert curly quotes. `/bin/sh` only understands
 * ASCII `'` / `"`, so normalize common typography quotes before exec.
 */
export function normalizeShellText(text: string): string {
  return text
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
}

export const shellNode = defineNode<Config>({
  type: "shell",
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

        const command = normalizeShellText(String(renderDeep(config.command, scope)));
        const args = config.args
          ? config.args.map((a) => normalizeShellText(String(renderDeep(a, scope))))
          : undefined;
        const cwd = config.cwd
          ? String(renderDeep(config.cwd, scope))
          : ctx.workspace;
        const renderedEnvRaw = config.env
          ? (renderDeep(config.env, scope) as Record<string, string>)
          : undefined;
        const renderedEnv = renderedEnvRaw
          ? Object.fromEntries(
              Object.entries(renderedEnvRaw).map(([k, v]) => [k, normalizeShellText(String(v))]),
            )
          : undefined;
        const input = config.input
          ? (renderDeep(config.input, scope) as Record<string, unknown>)
          : undefined;

        const timeoutMs = config.timeout ? parseDuration(config.timeout) : DEFAULT_TIMEOUT_MS;
        const allowedExit = config.expect?.exitCode ?? [0];

        const env: NodeJS.ProcessEnv = {
          ...process.env,
          ...renderedEnv,
        };
        let stdinData: string | undefined;
        if (input !== undefined) {
          const payload = JSON.stringify(input);
          env.FLOWGRAPH_INPUT = payload;
          stdinData = payload;
        }

        const useShell = args === undefined;
        ctx.logger.debug("shell exec", {
          command,
          args,
          cwd,
          shell: useShell,
          timeoutMs,
        });

        const { stdout, stderr, exitCode } = await runProcess({
          command,
          ...(args !== undefined ? { args } : {}),
          shell: useShell,
          cwd,
          env,
          timeoutMs,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(stdinData !== undefined ? { stdin: stdinData } : {}),
        });

        if (!allowedExit.includes(exitCode)) {
          const excerpt = stderr.trim().slice(0, 500) || stdout.trim().slice(0, 500);
          throw new Error(
            `shell node: command exited with code ${exitCode}` +
              (excerpt ? `: ${excerpt}` : ""),
          );
        }

        let json: unknown;
        const trimmed = stdout.trim();
        if (trimmed) {
          try {
            json = JSON.parse(trimmed);
          } catch {
            /* not JSON */
          }
        }

        const result: Record<string, unknown> = {
          stdout,
          stderr,
          exitCode,
          ...(json !== undefined ? { json } : {}),
        };

        ctx.emit("node.output", {
          command,
          args,
          cwd,
          exitCode,
          stdout,
          stderr,
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
  args?: string[];
  shell: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  stdin?: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { command, args, shell, cwd, env, timeoutMs, signal, stdin } = opts;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }

    const child = shell
      ? spawn(command, {
          shell: true,
          cwd,
          env,
          signal,
        })
      : spawn(command, args ?? [], {
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
        reject(new Error(`shell node: command timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
      if (stdout.length > MAX_BUFFER) {
        child.kill("SIGKILL");
        finish(new Error(`shell node: stdout exceeded maxBuffer (${MAX_BUFFER} bytes)`));
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > MAX_BUFFER) {
        child.kill("SIGKILL");
        finish(new Error(`shell node: stderr exceeded maxBuffer (${MAX_BUFFER} bytes)`));
      }
    });

    child.on("error", (err) => finish(err));
    child.on("close", (code) => finish(undefined, code ?? 1));

    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin?.end();
    }
  });
}
