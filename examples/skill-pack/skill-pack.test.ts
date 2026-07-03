import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { loadSkill } from "@veloxdevworks/flowgraph-skills";
import slugify from "./skills/slugify/handler.js";
import wordCount from "./skills/word-count/handler.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("example skill pack — contracts", () => {
  it("slugify SKILL.md is a valid skill contract", async () => {
    const { skill, diagnostics } = await loadSkill(path.join(here, "skills/slugify"));
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(skill?.frontMatter.name).toBe("slugify");
  });

  it("word-count SKILL.md is a valid skill contract", async () => {
    const { skill, diagnostics } = await loadSkill(path.join(here, "skills/word-count"));
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(skill?.frontMatter.name).toBe("word-count");
  });
});

describe("example skill pack — handlers", () => {
  it("slugify produces a URL-safe slug", () => {
    expect(slugify({ text: "Hello, World! Release v2.0" }).slug).toBe("hello-world-release-v2-0");
    expect(slugify({ text: "Trim Me", maxLength: 4 }).slug).toBe("trim");
  });

  it("word-count returns text statistics", () => {
    const r = wordCount({ text: "Hello world. How are you?" });
    expect(r.words).toBe(5);
    expect(r.sentences).toBe(2);
    expect(r.characters).toBeGreaterThan(0);
  });
});
