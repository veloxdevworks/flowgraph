/**
 * Built-in node type: `shell`
 *
 * Runs a local command. When `args` is set, uses execFile (no shell, argv-safe).
 * When `args` is omitted, runs `command` through the OS shell (pipes / && / globs).
 */

import * as path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { ShellWithSchema } from "@flowgraph/spec";
import { renderDeep } from "@flowgraph/expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { assertHostProbeAllowed, assertSecretAllowed, nodePolicyOf } from "../node-policy.js";
import { secretScope } from "../runtime/secret-scope.js";
import { parseDuration } from "../runtime/duration.js";
import { applyOutput } from "./output.js";
import {
  findMissingBins,
  isCommandNotFoundExit,
  missingToolIssue,
  spawnMissingToolError,
} from "../runtime/requires.js";
import { DEFAULT_INHERITED_ENV, pickHostEnv } from "../runtime/child-env.js";

import {ReplayStore,replayNodeKey,runScopeOf,toolArgsHash} from "../providers/replay-cache.js";
import {bindNodeReplay,isPendingStep,pendingStep,uncertainStep} from "../providers/replay-persistence.js";

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
          secret: secretScope(ctx),
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

        assertHostProbeAllowed(nodePolicyOf(ctx), config.requires, `shell node "${ctx.nodeId}"`);
        const missing = await findMissingBins(config.requires);
        if (missing.length > 0) {
          const skip = config.onMissingTool === "skip";
          ctx.issue(missingToolIssue(missing, { command, skipped: skip }));
          if (skip) {
            const result = {
              ok: false,
              skipped: true,
              missing: missing.map((m) => m.bin),
              stdout: "",
              stderr: "",
              exitCode: null,
            };
            ctx.emit("node.output", result);
            return {
              update: applyOutput(config.output, result, {
                nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
                scope,
              }),
            };
          }
          throw new Error(missingToolIssue(missing, { command, skipped: false }).message);
        }

        for (const name of config.inheritEnv ?? []) {
          assertSecretAllowed(nodePolicyOf(ctx), name, `shell node "${ctx.nodeId}"`);
        }
        const env: NodeJS.ProcessEnv = {
          ...pickHostEnv([...DEFAULT_INHERITED_ENV, ...(config.inheritEnv ?? [])]),
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

        const runScope=runScopeOf((ctx as NodeRunContext&{_lgConfig?:unknown})._lgConfig);
        const replay=runScope?.replay??new ReplayStore(),key=replayNodeKey(runScope?.path??[],ctx.nodeId),slot=`shell:${ctx.attempt}`;
        await bindNodeReplay(ctx,key);
        const identity=toolArgsHash({command,args,cwd,env,stdinData});
        if(runScope?.replayWorkspace){const rel=path.relative(ctx.workspace,path.resolve(cwd));if(rel.startsWith("..")||path.isAbsolute(rel))throw Object.assign(new Error(`Shell node "${ctx.nodeId}" cwd escapes the replay workspace`),{code:"REPLAY_WORKSPACE_ESCAPE",retryable:false});}
        const saved=replay.get(key,slot);
        const inFlight=Object.entries(replay.snapshot(key)).find(([name,value])=>name.startsWith("shell:")&&isPendingStep(value));
        if(inFlight&&isPendingStep(inFlight[1]))throw uncertainStep(inFlight[1]);
        const cached=saved as {identity:string;result:{stdout:string;stderr:string;exitCode:number}}|undefined;
        if(cached&&cached.identity!==identity)throw Object.assign(new Error(`Shell node "${ctx.nodeId}" command changed during crash recovery`),{code:"REPLAY_MISMATCH",retryable:false});
        let proc: { stdout: string; stderr: string; exitCode: number };
        try {
          if(cached)proc=cached.result;
          else {
          replay.set(key,slot,pendingStep("shell",{identity}));await replay.flush(key);
          proc = await runProcess({
            command,
            ...(args !== undefined ? { args } : {}),
            shell: useShell,
            cwd,
            env,
            timeoutMs,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            ...(stdinData !== undefined ? { stdin: stdinData } : {}),
            onAbort:()=>replay.delete(key,slot),
          });
          if(allowedExit.includes(proc.exitCode))replay.set(key,slot,{identity,result:proc});
          else replay.delete(key,slot);
          await replay.flush(key);
          }
        } catch (err) {
          if((err as {processStopped?:boolean})?.processStopped){replay.delete(key,slot);await replay.flush(key);}
          const mapped = spawnMissingToolError(err, command);
          if (mapped) {
            replay.delete(key,slot);await replay.flush(key);
            ctx.issue(missingToolIssue([{ bin: command }], { command, skipped: false }));
            throw mapped;
          }
          throw err;
        }
        const { stdout, stderr, exitCode } = proc;

        if (!allowedExit.includes(exitCode)) {
          if (isCommandNotFoundExit(exitCode, stderr)) {
            ctx.issue(missingToolIssue([{ bin: command }], { command, skipped: false }));
            throw new Error(
              `required binary for "${command}" was not found (exit ${exitCode}). Install it and re-run.` +
                (stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""),
            );
          }
          const excerpt = stderr.trim().slice(-500) || stdout.trim().slice(-500);
          throw new Error(
            `shell node "${ctx.nodeId}": command exited with code ${exitCode}` +
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
  onAbort?:()=>void;
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
          detached: process.platform !== "win32",
        })
      : spawn(command, args ?? [], {
          shell: false,
          cwd,
          env,
          detached: process.platform !== "win32",
        });

    const kill = (sig:NodeJS.Signals):void => {
      try { if(process.platform!=="win32"&&child.pid)process.kill(-child.pid,sig);else child.kill(sig); } catch { /* already exited */ }
    };
    const onAbort=()=>{kill("SIGKILL");opts.onAbort?.();};
    signal?.addEventListener("abort",onAbort,{once:true});
    if(signal?.aborted)onAbort();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGKILL");
    }, timeoutMs);

    const finish = (err?: Error, exitCode = 1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort",onAbort);
      if (signal?.aborted) { reject(signal.reason ?? new Error("Aborted"));return; }
      if (err) {
        reject(err);
        return;
      }
      if (timedOut) {
        reject(Object.assign(new Error(`shell node: command timed out after ${timeoutMs}ms`),{processStopped:true}));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
      if (stdout.length > MAX_BUFFER) {
        kill("SIGKILL");
        finish(new Error(`shell node: stdout exceeded maxBuffer (${MAX_BUFFER} bytes)`));
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > MAX_BUFFER) {
        kill("SIGKILL");
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
