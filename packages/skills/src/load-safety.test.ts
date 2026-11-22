import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkill, preflightSkill, SkillFrontMatterSchema, type SkillDef } from "./index.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fg-skill-load-"));
  dirs.push(dir);
  return dir;
}

function skillWithBin(name: string): SkillDef {
  return {
    path: "SKILL.md",
    body: "",
    frontMatter: {
      name: "needs-bin",
      kindOf: "command",
      env: { bin: [{ name, optional: false }] },
    },
  };
}

describe("SKILL.md front matter", () => {
  it("rejects a js engine without evaluating it", async () => {
    const dir = await tempDir();
    const marker = join(dir, "marker.txt");
    const source = [
      "---js",
      `(require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"), { name: "pwn" })`,
      "---",
      "body",
      "",
    ].join("\n");
    await writeFile(join(dir, "SKILL.md"), source);
    const { skill, diagnostics } = await loadSkill(dir);
    expect(skill).toBeNull();
    expect(existsSync(marker)).toBe(false);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SKILL_FRONT_MATTER_ERROR",
        message: expect.stringMatching(/must be YAML/),
      }),
    );
    expect(diagnostics[0]?.message).toContain('"js"');
  });

  it.each(["javascript", "json", "coffee", "toml"])("rejects the %s engine", async (engine) => {
    const dir = await tempDir();
    await writeFile(join(dir, "SKILL.md"), `---${engine}\n{ "name": "x" }\n---\nbody\n`);
    const { skill, diagnostics } = await loadSkill(dir);
    expect(skill).toBeNull();
    expect(diagnostics[0]).toMatchObject({
      code: "SKILL_FRONT_MATTER_ERROR",
      message: expect.stringContaining(`"${engine}"`),
    });
  });

  it("loads CRLF front matter whose last line is a command list", async () => {
    const dir = await tempDir();
    const source = [
      "---",
      "name: echo-skill",
      "kindOf: command",
      "command: [echo]",
      "---",
      "Run echo.",
      "",
    ].join("\r\n");
    expect(source).toContain("command: [echo]\r\n");
    await writeFile(join(dir, "SKILL.md"), source);
    const { skill, diagnostics } = await loadSkill(dir);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(skill?.frontMatter.name).toBe("echo-skill");
    expect(skill?.frontMatter.command).toEqual(["echo"]);
    expect(skill?.body).toBe("Run echo.");
  });

  it("loads a yaml fence and keeps the body", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "SKILL.md"),
      "---yaml\nname: ok\nkindOf: command\ncommand: [echo]\n---\nHello\n",
    );
    const { skill, diagnostics } = await loadSkill(dir);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(skill?.frontMatter.name).toBe("ok");
    expect(skill?.body).toBe("Hello");
  });
});

describe("env.bin names", () => {
  it("accepts a single executable name and rejects a shell command", () => {
    expect(
      SkillFrontMatterSchema.safeParse({ name: "s", env: { bin: [{ name: "git" }] } }).success,
    ).toBe(true);
    const bad = SkillFrontMatterSchema.safeParse({
      name: "s",
      env: { bin: [{ name: "sh; touch /tmp/x" }] },
    });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toMatch(/executable name/);
  });

  it("does not build a shell command from the bin name", async () => {
    const dir = await tempDir();
    const marker = join(dir, "pwned.txt");
    const name = `sh; touch ${marker}`;
    const result = await preflightSkill(skillWithBin(name));
    expect(existsSync(marker)).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.bins[name]).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "BIN_NAME_INVALID" }),
    );
  });

  it("finds node on PATH without a shell", async () => {
    const result = await preflightSkill(skillWithBin("node"));
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.bins["node"]).toBe(true);
  });
});
