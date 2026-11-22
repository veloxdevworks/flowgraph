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

const MAX_BUFFER = 10 * 1024 * 1024;

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
      return await runCommand(skill.frontMatter.command, skillEnvNames(skill, skillCtx), input, skillCtx);
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
    if (!(outputName in record) || record[outputName] === undefined) {
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
): Promise<unknown> {
  const [cmd, ...args] = command as [string, ...string[]];
  const payload = JSON.stringify(input);
  const env = { ...pickHostEnv([...DEFAULT_INHERITED_ENV, ...envNames]), FLOWGRAPH_INPUT: payload };

  const stdout = await new Promise<string>((resolve, reject) => {
    if (ctx.signal?.aborted) {
      reject(ctx.signal.reason ?? new Error("Aborted"));
      return;
    }

    const child = spawn(cmd, args, {
      env,
      cwd: ctx.workspace,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    let out = "";
    let errText = "";
    let outBytes = 0;
    let errBytes = 0;

    const finish = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      ctx.signal?.removeEventListener("abort", onAbort);
      if (err !== undefined) reject(err);
      else resolve(out);
    };

    const onAbort = (): void => {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      finish(ctx.signal?.reason ?? new Error("Aborted"));
    };

    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes <= MAX_BUFFER) out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes <= MAX_BUFFER) errText += chunk.toString("utf8");
    });

    child.on("error", (err) => finish(err));
    child.on("close", (code, sig) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = errText.trim().slice(-500) || out.trim().slice(-500);
      finish(
        new Error(
          `command "${cmd}" exited with ${code !== null ? `code ${code}` : `signal ${sig}`}` +
            (detail ? `: ${detail}` : ""),
        ),
      );
    });

    child.stdin?.on("error", () => { /* ignore EPIPE if child exits before reading stdin */ });
    child.stdin?.end(payload);
  });

  try { return JSON.parse(stdout) as unknown; }
  catch { return stdout.trim(); }
}
