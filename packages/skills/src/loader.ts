import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Diagnostic } from "@flowgraph/spec";
import { parseYamlFrontMatter, YamlFrontMatterError } from "./front-matter.js";
import { SkillFrontMatterSchema, type SkillDef } from "./schema.js";

/**
 * Load and parse a SKILL.md file (or a directory containing one).
 */
export async function loadSkill(
  skillPath: string,
): Promise<{ skill: SkillDef | null; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];

  let resolvedPath = skillPath;

  // If the path is a directory, look for SKILL.md inside
  try {
    const stat = await fs.stat(skillPath);
    if (stat.isDirectory()) {
      resolvedPath = path.join(skillPath, "SKILL.md");
    }
  } catch {
    diagnostics.push({
      severity: "error",
      code: "SKILL_NOT_FOUND",
      message: `Skill not found: ${skillPath}`,
    });
    return { skill: null, diagnostics };
  }

  // Read the file
  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf-8");
  } catch {
    diagnostics.push({
      severity: "error",
      code: "SKILL_NOT_FOUND",
      message: `Cannot read skill file: ${resolvedPath}`,
    });
    return { skill: null, diagnostics };
  }

  let parsed: { data: unknown; content: string };
  try {
    parsed = parseYamlFrontMatter(raw);
  } catch (err) {
    const detail =
      err instanceof YamlFrontMatterError
        ? err.message
        : `Front matter must be YAML. ${String(err)}`;
    diagnostics.push({
      severity: "error",
      code: "SKILL_FRONT_MATTER_ERROR",
      file: resolvedPath,
      message: `${resolvedPath}: ${detail}`,
    });
    return { skill: null, diagnostics };
  }
  const frontMatterResult = SkillFrontMatterSchema.safeParse(parsed.data);

  if (!frontMatterResult.success) {
    for (const issue of frontMatterResult.error.issues) {
      diagnostics.push({
        severity: "error",
        code: "SKILL_SCHEMA_ERROR",
        message: `${issue.path.join(".")}: ${issue.message}`,
        path: issue.path.join("."),
      });
    }
    return { skill: null, diagnostics };
  }

  const fm = frontMatterResult.data;
  const skillDir = path.dirname(resolvedPath);
  const handlerPath = fm.handler ? path.resolve(skillDir, fm.handler) : undefined;

  return {
    skill: {
      path: resolvedPath,
      frontMatter: fm,
      body: parsed.content.trim(),
      handlerPath,
    },
    diagnostics,
  };
}
