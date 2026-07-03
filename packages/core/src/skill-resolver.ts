/**
 * Skill resolution: translate a `uses:` string into a filesystem path.
 *
 * Resolution order:
 *  1. Explicit alias declared in graph config.skills
 *  2. Relative path from the graph's working directory (./skills/foo, skills/foo)
 *  3. Node module resolution (@scope/skill-foo)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";

export interface SkillAliasMap {
  [alias: string]: string;
}

export interface SkillResolverOptions {
  /** Working directory of the graph (usually where the .graph.yaml lives) */
  cwd: string;
  /** Alias map from graph config (alias → path or package name) */
  aliases?: SkillAliasMap;
}

/**
 * Resolve a skill `uses` reference to an absolute filesystem path.
 * Throws if the resolved path doesn't exist.
 */
export async function resolveSkillPath(uses: string, opts: SkillResolverOptions): Promise<string> {
  const { cwd, aliases = {} } = opts;

  // 1. Explicit alias
  if (uses in aliases) {
    const aliased = aliases[uses]!;
    return resolveSkillPath(aliased, { cwd, aliases: {} });
  }

  // 2. Relative/absolute path (starts with . / ./ ../ or is absolute)
  if (uses.startsWith(".") || uses.startsWith("/") || /^[a-zA-Z]:\\/.test(uses)) {
    const resolved = path.resolve(cwd, uses);
    return findSkillRoot(resolved);
  }

  // 3. Bare path without ./ (e.g. "skills/mock-create-ticket") — try relative first
  const candidateRelative = path.resolve(cwd, uses);
  try {
    return await findSkillRoot(candidateRelative);
  } catch {
    // Fall through to package resolution
  }

  // 4. Node module / npm package
  try {
    const req = createRequire(path.join(cwd, "package.json"));
    const pkgMain = req.resolve(uses);
    return findSkillRoot(path.dirname(pkgMain));
  } catch {
    throw new Error(
      `Cannot resolve skill "${uses}". ` +
        `Tried: relative path "${candidateRelative}", npm package "${uses}". ` +
        `Check the 'uses:' value or register an alias in graph config.`,
    );
  }
}

async function findSkillRoot(candidate: string): Promise<string> {
  // If it directly points to a SKILL.md
  if (candidate.endsWith("SKILL.md")) {
    try {
      await fs.access(candidate);
      return path.dirname(candidate);
    } catch {
      throw new Error(`SKILL.md not found: ${candidate}`);
    }
  }

  // If it's a directory, look for SKILL.md inside
  try {
    const stat = await fs.stat(candidate);
    if (stat.isDirectory()) {
      const skillMd = path.join(candidate, "SKILL.md");
      await fs.access(skillMd);
      return candidate;
    }
  } catch {
    // Not a directory or SKILL.md not found
  }

  throw new Error(`Skill not found at "${candidate}" (no SKILL.md)`);
}
