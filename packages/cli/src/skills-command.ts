/**
 * `flowgraph skills` subcommands: doctor, list
 */

import { Command } from "commander";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import pc from "picocolors";
import { loadSkill, preflightSkill, formatPreflightReport } from "@veloxdevworks/flowgraph-skills";
import { resolveSkillPath } from "@veloxdevworks/flowgraph-core";
import { printError, printSuccess } from "./ui.js";

export function buildSkillsCommand(): Command {
  const skills = new Command("skills").description("Inspect and validate skills");

  // --------------------------------------------------------------------------
  // skills doctor
  // --------------------------------------------------------------------------
  skills
    .command("doctor [paths...]")
    .description("Check that all skill environment dependencies are satisfied")
    .option("--json", "Output as JSON")
    .option("--cwd <dir>", "Working directory")
    .action(async (paths: string[], opts: { json?: boolean; cwd?: string }) => {
      const cwd = opts.cwd ?? process.cwd();

      // If no paths given, scan for skills in ./skills/
      const targets: string[] =
        paths.length > 0
          ? paths.map((p) => path.resolve(cwd, p))
          : await discoverSkills(path.join(cwd, "skills"));

      if (targets.length === 0) {
        console.log(pc.yellow("No skills found. Pass paths or add skills/ directory."));
        return;
      }

      const results: Array<{ skill: Awaited<ReturnType<typeof loadSkill>>["skill"]; result: ReturnType<typeof preflightSkill> extends Promise<infer T> ? T : never }> = [];
      let hasError = false;

      for (const target of targets) {
        const { skill, diagnostics } = await loadSkill(target);
        if (!skill) {
          printError(`Cannot load skill at ${target}: ${diagnostics.map((d) => d.message).join("; ")}`);
          hasError = true;
          continue;
        }
        const result = await preflightSkill(skill);
        if (!result.ok) hasError = true;
        results.push({ skill, result } as (typeof results)[number]);
      }

      if (opts.json) {
        console.log(JSON.stringify(results.map(({ skill, result }) => ({
          name: skill!.frontMatter.name,
          path: skill!.path,
          ok: result.ok,
          vars: result.vars,
          bins: result.bins,
          diagnostics: result.diagnostics,
        })), null, 2));
      } else {
        console.log(formatPreflightReport(results as Parameters<typeof formatPreflightReport>[0]));
      }

      process.exit(hasError ? 1 : 0);
    });

  // --------------------------------------------------------------------------
  // skills list
  // --------------------------------------------------------------------------
  skills
    .command("list [dir]")
    .description("List all skills in a directory")
    .option("--json", "Output as JSON")
    .action(async (dir: string | undefined, opts: { json?: boolean }) => {
      const cwd = dir ? path.resolve(dir) : path.join(process.cwd(), "skills");

      const skillPaths = await discoverSkills(cwd);
      if (skillPaths.length === 0) {
        console.log(pc.dim(`No skills found in ${cwd}`));
        return;
      }

      const loaded = await Promise.all(
        skillPaths.map(async (p) => {
          const { skill } = await loadSkill(p);
          return skill;
        }),
      );
      const skills = loaded.filter(Boolean);

      if (opts.json) {
        console.log(
          JSON.stringify(
            skills.map((s) => ({
              name: s!.frontMatter.name,
              version: s!.frontMatter.version,
              description: s!.frontMatter.description,
              kind_of: s!.frontMatter.kind_of,
              inputs: Object.keys(s!.frontMatter.inputs ?? {}),
              outputs: Object.keys(s!.frontMatter.outputs ?? {}),
              path: s!.path,
            })),
            null,
            2,
          ),
        );
      } else {
        console.log(pc.bold(`Skills in ${cwd}\n`));
        for (const s of skills) {
          const fm = s!.frontMatter;
          const io = `${Object.keys(fm.inputs ?? {}).length} in / ${Object.keys(fm.outputs ?? {}).length} out`;
          console.log(`  ${pc.cyan(fm.name)}  ${pc.dim(`v${fm.version ?? "?"}`)}  [${fm.kind_of}]  ${pc.dim(io)}`);
          if (fm.description) console.log(`    ${pc.dim(fm.description.trim().split("\n")[0])}`);
        }
        console.log(pc.dim(`\n${skills.length} skill(s) found`));
      }
    });

  // --------------------------------------------------------------------------
  // skills resolve
  // --------------------------------------------------------------------------
  skills
    .command("resolve <uses>")
    .description("Show where a skill reference resolves to")
    .option("--cwd <dir>", "Working directory")
    .action(async (uses: string, opts: { cwd?: string }) => {
      const cwd = opts.cwd ?? process.cwd();
      try {
        const resolved = await resolveSkillPath(uses, { cwd });
        printSuccess(`${uses} → ${resolved}`);
      } catch (err) {
        printError(String(err));
        process.exit(1);
      }
    });

  return skills;
}

async function discoverSkills(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMd = path.join(dir, entry.name, "SKILL.md");
        try {
          await fs.access(skillMd);
          results.push(path.join(dir, entry.name));
        } catch {
          // No SKILL.md in this subdir, recurse one level
        }
      } else if (entry.name === "SKILL.md") {
        results.push(dir);
        break;
      }
    }
  } catch {
    // Directory doesn't exist — return empty
  }
  return results;
}
