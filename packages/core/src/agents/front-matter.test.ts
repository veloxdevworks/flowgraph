import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentDef } from "./loader.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("AGENT.md front matter", () => {
  it("rejects a js engine without evaluating it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fg-agent-fm-"));
    dirs.push(dir);
    const marker = join(dir, "marker.txt");
    const source = [
      "---js",
      `(require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"), { name: "pwn" })`,
      "---",
      "You are not loaded.",
      "",
    ].join("\n");
    await writeFile(join(dir, "AGENT.md"), source);
    const { agent, diagnostics } = await loadAgentDef(dir);
    expect(agent).toBeNull();
    expect(existsSync(marker)).toBe(false);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "AGENT_FRONT_MATTER_ERROR",
        file: join(dir, "AGENT.md"),
        message: expect.stringMatching(/must be YAML/),
      }),
    );
    expect(diagnostics[0]?.message).toContain('"js"');
  });

  it.each(["javascript", "json"])("rejects the %s engine", async (engine) => {
    const dir = await mkdtemp(join(tmpdir(), "fg-agent-fm-"));
    dirs.push(dir);
    await writeFile(join(dir, "AGENT.md"), `---${engine}\n{ "name": "x" }\n---\nbody\n`);
    const { agent, diagnostics } = await loadAgentDef(dir);
    expect(agent).toBeNull();
    expect(diagnostics[0]?.message).toContain(`"${engine}"`);
    expect(diagnostics[0]?.code).toBe("AGENT_FRONT_MATTER_ERROR");
  });

  it("loads CRLF front matter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fg-agent-fm-"));
    dirs.push(dir);
    await writeFile(
      join(dir, "AGENT.md"),
      ["---", "name: reviewer", "description: Careful", "---", "Be specific.", ""].join("\r\n"),
    );
    const { agent, diagnostics } = await loadAgentDef(dir);
    expect(diagnostics).toEqual([]);
    expect(agent?.frontMatter.name).toBe("reviewer");
    expect(agent?.frontMatter.description).toBe("Careful");
    expect(agent?.body).toBe("Be specific.");
  });

  it("loads a yaml fence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fg-agent-fm-"));
    dirs.push(dir);
    await writeFile(
      join(dir, "AGENT.md"),
      "---yaml\nname: reviewer\ndescription: Careful\n---\nBe specific.\n",
    );
    const { agent, diagnostics } = await loadAgentDef(dir);
    expect(diagnostics).toEqual([]);
    expect(agent?.frontMatter.name).toBe("reviewer");
    expect(agent?.frontMatter.description).toBe("Careful");
    expect(agent?.body).toBe("Be specific.");
  });
});
