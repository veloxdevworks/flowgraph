/**
 * Shared skill execution: resolve a SKILL.md, preflight, run its handler.
 * Used by both the `skill` node and skill-as-tool for agent nodes.
 */

import { spawn } from "node:child_process";
import {
  isRequiredSkillInput,
  loadSkill,
  preflightSkill,
  skillInputValueSchema,
  type SkillDef,
} from "@flowgraph/skills";
import { resolveSkillPath } from "../skill-resolver.js";
import { contractErrors } from "../runtime/json-schema.js";
import { parseDuration } from "../runtime/duration.js";
import { DEFAULT_INHERITED_ENV, pickHostEnv } from "../runtime/child-env.js";
import { assertSecretDeclared, declaredSecretsOf } from "../runtime/secret-scope.js";
import { assertSecretAllowed, nodePolicyOf } from "../node-policy.js";
import type { NodeRunContext } from "../context.js";

export const DEFAULT_SKILL_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * After SIGTERM, SIGKILL the skill command's process group. If the direct child
 * is still running, wait this long so it can exit cleanly; if it has already
 * closed, SIGKILL immediately so grandchildren ignoring SIGTERM are cleaned up.
 */
export const DEFAULT_SKILL_STOP_GRACE_MS = 2_000;

export interface RunSkillOptions {
  /** How long a stop waits for a command skill after SIGTERM before SIGKILL. Defaults to 2s. */
  stopGraceMs?: number;
  /** Maximum stdout or stderr byte length before failing with SKILL_OUTPUT_LIMIT. Defaults to 10 MiB. */
  maxBuffer?: number;
}

export async function loadResolvedSkill(uses: string, ctx: NodeRunContext): Promise<SkillDef> {
  const skillDir = await resolveSkillPath(uses, {
    cwd: typeof ctx.config.graphDir === "string" ? ctx.config.graphDir : ctx.workspace,
    aliases:
      (ctx.config as Record<string, unknown> & { skills?: Record<string, string> })?.skills ?? {},
  });
  const { skill, diagnostics } = await loadSkill(skillDir);
  if (!skill) {
    throw new Error(`could not load skill "${uses}": ${diagnostics.map((d) => d.message).join("; ")}`);
  }
  return skill;
}

export async function runSkill(
  skill: SkillDef,
  input: Record<string, unknown>,
  ctx: NodeRunContext,
  opts: RunSkillOptions = {},
): Promise<unknown> {
  ctx.emit("skill.preflight", { skill: skill.frontMatter.name, path: skill.path });
  const preflight = await preflightSkill(skill);
  if (!preflight.ok) {
    const errors = preflight.diagnostics.filter((d) => d.severity === "error");
    throw new Error(
      `skill "${skill.frontMatter.name}" preflight failed:\n` +
        errors.map((e) => `  - ${e.message}`).join("\n"),
    );
  }

  const declaredInputs = skill.frontMatter.inputs ?? {};
  for (const [inputName, inputDecl] of Object.entries(declaredInputs)) {
    if (input[inputName] == null) {
      if (isRequiredSkillInput(inputDecl)) {
        throw new Error(`skill "${skill.frontMatter.name}": required input "${inputName}" is missing`);
      }
      continue;
    }
    const errors = contractErrors(input[inputName], skillInputValueSchema(inputDecl));
    if (errors) {
      throw new Error(`skill "${skill.frontMatter.name}": input "${inputName}" does not match schema: ${errors}`);
    }
  }

  ctx.emit("skill.start", { skill: skill.frontMatter.name, inputs: Object.keys(input) });

  const execute = async (skillCtx: NodeRunContext): Promise<unknown> => {
    if (skill.frontMatter.kindOf === "executable" && skill.handlerPath) {
      const mod = (await import(skill.handlerPath)) as { default?: unknown; handler?: unknown };
      const handler = (mod.default ?? mod.handler) as
        | ((input: unknown, ctx: NodeRunContext) => unknown)
        | undefined;
      if (typeof handler !== "function") {
        throw new Error(
          `skill "${skill.frontMatter.name}": handler at ${skill.handlerPath} must export a default function`,
        );
      }
      return await handler(input, skillCtx);
    }
    if (skill.frontMatter.kindOf === "command" && skill.frontMatter.command) {
      return await runCommand(skill.frontMatter.command, skillEnvNames(skill, skillCtx), input, skillCtx, opts);
    }
    throw new Error(
      `skill "${skill.frontMatter.name}": kindOf="${skill.frontMatter.kindOf}" is not configured correctly. ` +
        `Set 'handler' (executable) or 'command' (command).`,
    );
  };

  const result = await withSkillTimeout(skill, ctx, execute);
  validateSkillOutputs(skill, result);

  ctx.emit("skill.end", { skill: skill.frontMatter.name, result });
  return result;
}

async function withSkillTimeout(
  skill: SkillDef,
  ctx: NodeRunContext,
  execute: (skillCtx: NodeRunContext) => Promise<unknown>,
): Promise<unknown> {
  const timeout = skill.frontMatter.timeout;
  if (!timeout) return execute(ctx);

  const timeoutMs = parseDuration(timeout);
  const timedOut = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timedOut.signal]) : timedOut.signal;
  const skillCtx: NodeRunContext = { ...ctx, signal };

  // Command skills always honor ctx.signal with a bounded SIGTERM -> grace -> SIGKILL
  // teardown; wait for that teardown to complete before rejecting so the process group
  // is guaranteed dead when runSkill rejects.
  if (skill.frontMatter.kindOf === "command") {
    const timer = setTimeout(() => {
      const err = Object.assign(
        new Error(`skill "${skill.frontMatter.name}" timed out after ${timeout}`),
        { code: "SKILL_TIMEOUT", __timeout: true as const },
      );
      timedOut.abort(err);
    }, timeoutMs);
    try {
      return await execute(skillCtx);
    } finally {
      clearTimeout(timer);
    }
  }

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = Object.assign(
        new Error(`skill "${skill.frontMatter.name}" timed out after ${timeout}`),
        { code: "SKILL_TIMEOUT", __timeout: true as const },
      );
      timedOut.abort(err);
      reject(err);
    }, timeoutMs);

    Promise.resolve()
      .then(() => execute(skillCtx))
      .then(
        (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
  });
}

function validateSkillOutputs(skill: SkillDef, result: unknown): void {
  const declaredOutputs = skill.frontMatter.outputs;
  if (!declaredOutputs || Object.keys(declaredOutputs).length === 0) return;

  if (result == null || typeof result !== "object" || Array.isArray(result)) {
    throw Object.assign(
      new Error(`skill "${skill.frontMatter.name}": expected object output matching declared outputs`),
      { code: "SKILL_OUTPUT_INVALID", retryable: false },
    );
  }
  const record = result as Record<string, unknown>;
  for (const [outputName, outputSchema] of Object.entries(declaredOutputs)) {
    if (!Object.hasOwn(record, outputName) || record[outputName] === undefined) {
      throw Object.assign(
        new Error(`skill "${skill.frontMatter.name}": declared output "${outputName}" is missing`),
        { code: "SKILL_OUTPUT_INVALID", retryable: false },
      );
    }
    const errors = contractErrors(record[outputName], outputSchema);
    if (errors) {
      throw Object.assign(
        new Error(`skill "${skill.frontMatter.name}": output "${outputName}" does not match schema: ${errors}`),
        { code: "SKILL_OUTPUT_INVALID", retryable: false },
      );
    }
  }
}

/**
 * Host variables a command skill receives beyond the default allowlist: its
 * declared `env.vars`. A var marked `secret` passes only when the graph
 * declares it; a required one that is not declared fails the skill.
 */
export function skillEnvNames(skill: SkillDef, ctx: NodeRunContext): string[] {
  const declared = declaredSecretsOf(ctx);
  const where = `skill "${skill.frontMatter.name}"`;
  const names: string[] = [];
  for (const v of skill.frontMatter.env?.vars ?? []) {
    if (v.secret) {
      if (!declared.has(v.name) && v.optional) continue;
      assertSecretAllowed(nodePolicyOf(ctx), v.name, where);
      assertSecretDeclared(declared, v.name, where);
    }
    names.push(v.name);
  }
  return names;
}

async function runCommand(
  command: string[],
  envNames: readonly string[],
  input: Record<string, unknown>,
  ctx: NodeRunContext,
  opts: RunSkillOptions = {},
): Promise<unknown> {
  const [cmd, ...args] = command as [string, ...string[]];
  const payload = JSON.stringify(input);
  const env = { ...pickHostEnv([...DEFAULT_INHERITED_ENV, ...envNames]), FLOWGRAPH_INPUT: payload };
  const stopGraceMs = opts.stopGraceMs ?? DEFAULT_SKILL_STOP_GRACE_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_SKILL_MAX_BUFFER;

  const stdout = await new Promise<string>((resolve, reject) => {
    if (ctx.signal?.aborted) {
      reject(ctx.signal.reason ?? new Error("Aborted"));
      return;
    }

    const grouped = process.platform !== "win32";
    const child = spawn(cmd, args, {
      env,
      cwd: ctx.workspace,
      detached: grouped,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    let stopReason: unknown;
    let hasStopReason = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let closeResult: { err?: unknown; code?: number | null; sig?: NodeJS.Signals | null } | undefined;
    let out = "";
    let errText = "";
    let outBytes = 0;
    let errBytes = 0;

    const killGroup = (sig: NodeJS.Signals): void => {
      const pid = child.pid;
      if (grouped && pid !== undefined) {
        try {
          process.kill(-pid, sig);
          return;
        } catch {
          // Process group already exited.
        }
      }
      try {
        child.kill(sig);
      } catch {
        // Process already exited.
      }
    };

    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (grace) {
        clearTimeout(grace);
        grace = undefined;
      }
      ctx.signal?.removeEventListener("abort", onAbort);
      if (hasStopReason) {
        reject(stopReason);
        return;
      }
      if (closeResult?.err !== undefined) {
        reject(closeResult.err);
        return;
      }
      if (closeResult?.code === 0) {
        resolve(out);
        return;
      }
      const detail = errText.trim().slice(-500) || out.trim().slice(-500);
      reject(
        new Error(
          `command "${cmd}" exited with ${
            closeResult?.code !== null && closeResult?.code !== undefined
              ? `code ${closeResult.code}`
              : `signal ${closeResult?.sig ?? "unknown"}`
          }` + (detail ? `: ${detail}` : ""),
        ),
      );
    };

    const finishStop = (): void => {
      if (grace) {
        clearTimeout(grace);
        grace = undefined;
      }
      killGroup("SIGKILL");
      settle();
    };

    const requestStop = (reason: unknown): void => {
      if (hasStopReason) return;
      hasStopReason = true;
      stopReason = reason;
      killGroup("SIGTERM");
      if (settled) return;
      if (closeResult) {
        finishStop();
        return;
      }
      grace = setTimeout(finishStop, stopGraceMs);
    };

    const onAbort = (): void => {
      requestStop(ctx.signal?.reason ?? new Error("Aborted"));
    };

    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal?.aborted) onAbort();

    const overflow = (which: "stdout" | "stderr"): void => {
      if (hasStopReason) return;
      hasStopReason = true;
      stopReason = Object.assign(
        new Error(`command "${cmd}": ${which} exceeded maxBuffer (${maxBuffer} bytes)`),
        { code: "SKILL_OUTPUT_LIMIT", retryable: false },
      );
      finishStop();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (hasStopReason) return;
      outBytes += chunk.length;
      if (outBytes > maxBuffer) {
        overflow("stdout");
        return;
      }
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (hasStopReason) return;
      errBytes += chunk.length;
      if (errBytes > maxBuffer) {
        overflow("stderr");
        return;
      }
      errText += chunk.toString("utf8");
    });

    const noteClose = (result: { err?: unknown; code?: number | null; sig?: NodeJS.Signals | null }): void => {
      if (!closeResult?.err) closeResult = result;
      if (!hasStopReason) {
        settle();
        return;
      }
      finishStop();
    };

    child.on("error", (err) => noteClose({ err }));
    child.on("close", (code, sig) => noteClose({ code, sig }));

    child.stdin?.on("error", () => { /* ignore EPIPE if child exits before reading stdin */ });
    child.stdin?.end(payload);
  });

  try { return JSON.parse(stdout) as unknown; }
  catch { return stdout.trim(); }
}
