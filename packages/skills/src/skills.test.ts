import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import { loadSkill, preflightSkill } from "../src/index.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SKILL_PATH = path.resolve(__dirname, "../../../examples/triage-issue/skills/mock-create-ticket");

describe("loadSkill", () => {
  it("loads mock-create-ticket SKILL.md successfully", async () => {
    const { skill, diagnostics } = await loadSkill(SKILL_PATH);
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(skill).not.toBeNull();
    expect(skill!.frontMatter.name).toBe("mock-create-ticket");
    expect(skill!.frontMatter.kind_of).toBe("executable");
    expect(skill!.handlerPath).toContain("handler.js");
  });

  it("reports an error for a non-existent path", async () => {
    const { skill, diagnostics } = await loadSkill("/does/not/exist/SKILL.md");
    expect(skill).toBeNull();
    expect(diagnostics.some((d) => d.severity === "error")).toBe(true);
  });
});

describe("preflightSkill", () => {
  it("passes preflight for mock-create-ticket (all vars optional)", async () => {
    const { skill } = await loadSkill(SKILL_PATH);
    expect(skill).not.toBeNull();
    const result = await preflightSkill(skill!, {});
    // Both env vars are optional — should pass even when absent
    expect(result.ok).toBe(true);
    expect(result.vars["TRACKER_URL"]).toBe(false);
    expect(result.vars["TRACKER_API_KEY"]).toBe(false);
  });

  it("reports as ok when secrets are present", async () => {
    const { skill } = await loadSkill(SKILL_PATH);
    expect(skill).not.toBeNull();
    const result = await preflightSkill(skill!, {
      TRACKER_URL: "https://jira.example.com",
      TRACKER_API_KEY: "super-secret",
    });
    expect(result.ok).toBe(true);
    expect(result.vars["TRACKER_URL"]).toBe(true);
    expect(result.vars["TRACKER_API_KEY"]).toBe(true);
  });
});
