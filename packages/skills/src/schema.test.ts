import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRequiredSkillInput, loadSkill, SkillFrontMatterSchema, skillInputValueSchema } from "./index.js";

const base = { name: "s", handler: "./handler.js" };

describe("skill kinds", () => {
  it("accepts executable and command", () => {
    expect(SkillFrontMatterSchema.safeParse({ ...base, kind_of: "executable" }).success).toBe(true);
    expect(SkillFrontMatterSchema.safeParse({ name: "s", kind_of: "command", command: ["echo"] }).success).toBe(true);
  });

  it.each(["agent", "composite"])("rejects %s until it can run", (kind) => {
    const r = SkillFrontMatterSchema.safeParse({ ...base, kind_of: kind });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(`kind_of "${kind}" is not supported; use "executable" or "command"`);
  });

  it("fails at load time with a diagnostic", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-skill-kind-"));
    try {
      await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: s\nkind_of: agent\n---\nbody\n");
      const { skill, diagnostics } = await loadSkill(dir);
      expect(skill).toBeNull();
      expect(diagnostics).toEqual([
        expect.objectContaining({ code: "SKILL_SCHEMA_ERROR", path: "kind_of", message: expect.stringContaining('kind_of "agent" is not supported;') }),
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("skill input / output declarations", () => {
  it("use JSON Schema with an input-level required flag", () => {
    const r = SkillFrontMatterSchema.safeParse({
      ...base,
      inputs: {
        count: { type: "integer", minimum: 1, required: true },
        tags: { type: "array", items: { type: "string" } },
        meta: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      },
      outputs: { words: { type: "integer" } },
    });
    expect(r.success).toBe(true);
    expect(r.data?.inputs?.["count"]?.required).toBe(true);
    expect(r.data?.inputs?.["tags"]?.required).toBe(false);
    const meta = r.data!.inputs!["meta"]!;
    expect(isRequiredSkillInput(meta)).toBe(false);
    expect(skillInputValueSchema(meta)).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
    expect(skillInputValueSchema(r.data!.inputs!["count"]!)).toEqual({ type: "integer", minimum: 1 });
  });

  it("reject keywords and types outside the dialect", () => {
    for (const inputs of [
      { a: { type: "text" } },
      { a: { type: "any" } },
      { a: { type: "string", widget: "textarea" } },
      { a: { type: "object", properties: { b: { type: "string", required: true } } } },
    ]) {
      expect(SkillFrontMatterSchema.safeParse({ ...base, inputs }).success).toBe(false);
    }
    expect(SkillFrontMatterSchema.safeParse({ ...base, outputs: { a: { type: "any" } } }).success).toBe(false);
    // A templated description does not switch the check off.
    expect(
      SkillFrontMatterSchema.safeParse({ ...base, inputs: { a: { type: "strng", description: "{{ inputs.b }}" } } }).success,
    ).toBe(false);
  });
});
