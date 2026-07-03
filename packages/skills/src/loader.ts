import * as fs from "node:fs/promises";
import * as path from "node:path";
import matter from "gray-matter";
import { SkillFrontMatterSchema, type SkillDef } from "./schema.js";
import type { Diagnostic } from "@veloxdevworks/flowgraph-spec";

/**
 * Load and parse a SKILL.md file (or a directory containing one).
 */
export async function loadSkill(skillPath: string): Promise<{ skill: SkillDef | null; diagnostics: Diagnostic[] }> {
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

  // Parse front-matter
  const parsed = matter(raw);
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
