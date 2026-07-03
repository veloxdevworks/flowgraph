/**
 * Upfront skill preflight: resolve SKILL.md refs and check env/bin readiness.
 */

import { loadSkill, preflightSkill, formatPreflightReport } from "@veloxdevworks/flowgraph-skills";
import type { Diagnostic } from "@veloxdevworks/flowgraph-spec";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { resolveSkillPath } from "./skill-resolver.js";
import { discoverSkillUses } from "./discover-skills.js";

export interface PreflightGraphOptions {
  cwd: string;
  skillAliases?: Record<string, string>;
}

export interface PreflightGraphResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  report: string;
}

/**
 * Preflight all skill nodes referenced by a graph before execution.
 */
export async function preflightGraphSkills(
  spec: GraphSpec,
  opts: PreflightGraphOptions,
): Promise<PreflightGraphResult> {
  const uses = discoverSkillUses(spec);
  if (uses.length === 0) {
    return { ok: true, diagnostics: [], report: "" };
  }

  const aliases = opts.skillAliases ?? {};
  const diagnostics: Diagnostic[] = [];
  const reportRows: Parameters<typeof formatPreflightReport>[0] = [];

  for (const ref of uses) {
    let skillDir: string;
    try {
      skillDir = await resolveSkillPath(ref, { cwd: opts.cwd, aliases });
    } catch (err) {
      diagnostics.push({
        severity: "error",
        code: "SKILL_NOT_FOUND",
        message: `skill "${ref}": ${String(err)}`,
      });
      continue;
    }

    const { skill, diagnostics: loadDiags } = await loadSkill(skillDir);
    diagnostics.push(...loadDiags);
    if (!skill) continue;

    const result = await preflightSkill(skill);
    diagnostics.push(...result.diagnostics);
    reportRows.push({ skill, result });
  }

  const ok = diagnostics.every((d) => d.severity !== "error");
  const report = reportRows.length > 0 ? formatPreflightReport(reportRows) : "";
  return { ok, diagnostics, report };
}
