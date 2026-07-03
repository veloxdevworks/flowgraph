import * as childProcess from "node:child_process";
import * as util from "node:util";
import type { SkillDef, EnvVarDecl, BinDecl } from "./schema.js";
import type { Diagnostic } from "@veloxdevworks/flowgraph-spec";

const exec = util.promisify(childProcess.exec);

export interface PreflightResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Map of var name → whether it resolved */
  vars: Record<string, boolean>;
  /** Map of bin name → whether it's on PATH */
  bins: Record<string, boolean>;
}

/**
 * Check whether the current environment can execute a skill.
 * Cheap checks only — no network, no model calls.
 */
export async function preflightSkill(
  skill: SkillDef,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PreflightResult> {
  const diagnostics: Diagnostic[] = [];
  const vars: Record<string, boolean> = {};
  const bins: Record<string, boolean> = {};

  const envDecl = skill.frontMatter.env;

  // Check env vars
  for (const varDecl of envDecl?.vars ?? []) {
    const present = Boolean(env[varDecl.name]);
    vars[varDecl.name] = present;
    if (!present && !varDecl.optional) {
      diagnostics.push({
        severity: "error",
        code: "ENV_VAR_MISSING",
        message: `Skill "${skill.frontMatter.name}" requires env var ${varDecl.name}${varDecl.description ? ` (${varDecl.description})` : ""}`,
      });
    } else if (!present && varDecl.optional) {
      diagnostics.push({
        severity: "warning",
        code: "ENV_VAR_OPTIONAL_MISSING",
        message: `Skill "${skill.frontMatter.name}" optional env var ${varDecl.name} is not set`,
      });
    }
  }

  // Check binaries on PATH
  for (const binDecl of envDecl?.bin ?? []) {
    const onPath = await checkBin(binDecl.name);
    bins[binDecl.name] = onPath;
    if (!onPath && !binDecl.optional) {
      diagnostics.push({
        severity: "error",
        code: "BIN_NOT_FOUND",
        message: `Skill "${skill.frontMatter.name}" requires ${binDecl.name} on PATH`,
      });
    } else if (!onPath && binDecl.optional) {
      diagnostics.push({
        severity: "warning",
        code: "BIN_NOT_FOUND_OPTIONAL",
        message: `Skill "${skill.frontMatter.name}" optional binary ${binDecl.name} not found on PATH`,
      });
    }
  }

  // Check Node version constraint
  if (envDecl?.node) {
    const nodeVersion = process.version;
    const required = envDecl.node.replace(/^>=/, "");
    if (!satisfiesVersion(nodeVersion, required)) {
      diagnostics.push({
        severity: "error",
        code: "NODE_VERSION_MISMATCH",
        message: `Skill "${skill.frontMatter.name}" requires Node ${envDecl.node}, found ${nodeVersion}`,
      });
    }
  }

  const ok = diagnostics.every((d) => d.severity !== "error");
  return { ok, diagnostics, vars, bins };
}

async function checkBin(name: string): Promise<boolean> {
  try {
    const cmd = process.platform === "win32" ? `where ${name}` : `which ${name}`;
    await exec(cmd);
    return true;
  } catch {
    return false;
  }
}

function satisfiesVersion(actual: string, required: string): boolean {
  const parse = (v: string) =>
    v.replace(/^v/, "").split(".").map(Number) as [number, number, number];
  const [aMaj, aMin, aPatch] = parse(actual);
  const [rMaj, rMin, rPatch] = parse(required);
  if (aMaj !== rMaj) return (aMaj ?? 0) >= (rMaj ?? 0);
  if (aMin !== rMin) return (aMin ?? 0) >= (rMin ?? 0);
  return (aPatch ?? 0) >= (rPatch ?? 0);
}

/**
 * Format a preflight report as a human-readable string (for CLI output).
 */
export function formatPreflightReport(
  results: Array<{ skill: SkillDef; result: PreflightResult }>,
): string {
  const lines: string[] = [];

  for (const { skill, result } of results) {
    const name = skill.frontMatter.name;
    const status = result.ok ? "✓ ok" : "✗ error";
    lines.push(`\n${name}  ${status}`);

    for (const [varName, present] of Object.entries(result.vars)) {
      const secretTag = skill.frontMatter.env?.vars?.find((v) => v.name === varName)?.secret
        ? " (secret)"
        : "";
      lines.push(`  ${present ? "✓" : "✗"} ${varName}${secretTag}`);
    }

    for (const [binName, present] of Object.entries(result.bins)) {
      lines.push(`  ${present ? "✓" : "✗"} ${binName} [bin]`);
    }

    for (const d of result.diagnostics) {
      lines.push(`  ${d.severity === "error" ? "ERROR" : "WARN"}: ${d.message}`);
    }
  }

  const allOk = results.every((r) => r.result.ok);
  lines.push(allOk ? "\nAll checks passed." : "\nSome checks failed.");
  return lines.join("\n");
}

export type { EnvVarDecl, BinDecl };
