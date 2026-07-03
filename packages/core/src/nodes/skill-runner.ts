/**
 * Shared skill execution: resolve a SKILL.md, preflight, run its handler.
 * Used by both the `skill` node and skill-as-tool for intelligent nodes.
 */

import { loadSkill, preflightSkill, type SkillDef } from "@veloxdevworks/flowgraph-skills";
import { resolveSkillPath } from "../skill-resolver.js";
import type { NodeRunContext } from "../context.js";

export async function loadResolvedSkill(uses: string, ctx: NodeRunContext): Promise<SkillDef> {
  const skillDir = await resolveSkillPath(uses, {
    cwd: ctx.workspace,
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
    if (inputDecl.required && input[inputName] == null) {
      throw new Error(`skill "${skill.frontMatter.name}": required input "${inputName}" is missing`);
    }
  }

  ctx.emit("skill.start", { skill: skill.frontMatter.name, inputs: Object.keys(input) });

  let result: unknown;
  if (skill.frontMatter.kind_of === "executable" && skill.handlerPath) {
    const mod = (await import(skill.handlerPath)) as { default?: unknown; handler?: unknown };
    const handler = (mod.default ?? mod.handler) as
      | ((input: unknown, ctx: NodeRunContext) => unknown)
      | undefined;
    if (typeof handler !== "function") {
      throw new Error(
        `skill "${skill.frontMatter.name}": handler at ${skill.handlerPath} must export a default function`,
      );
    }
    result = await handler(input, ctx);
  } else if (skill.frontMatter.kind_of === "command" && skill.frontMatter.command) {
    result = await runCommand(skill.frontMatter.command, input, ctx);
  } else {
    throw new Error(
      `skill "${skill.frontMatter.name}": kind_of="${skill.frontMatter.kind_of}" is not configured correctly. ` +
        `Set 'handler' (executable) or 'command' (command).`,
    );
  }

  ctx.emit("skill.end", { skill: skill.frontMatter.name, result });
  return result;
}

async function runCommand(
  command: string[],
  input: Record<string, unknown>,
  ctx: NodeRunContext,
): Promise<unknown> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const [cmd, ...args] = command as [string, ...string[]];
  const { stdout } = await execFileAsync(cmd, args, {
    env: { ...process.env, FLOWGRAPH_INPUT: JSON.stringify(input) },
    cwd: ctx.workspace,
    signal: ctx.signal,
  });

  try { return JSON.parse(stdout) as unknown; }
  catch { return stdout.trim(); }
}
