import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseYamlFrontMatter, YamlFrontMatterError } from "@flowgraph/skills";
import type { Diagnostic } from "@flowgraph/spec";
import { AgentFrontMatterSchema, type AgentDef } from "./schema.js";

/**
 * Load and parse an AGENT.md file (or a directory containing one).
 */
export async function loadAgentDef(
  agentPath: string,
): Promise<{ agent: AgentDef | null; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];

  let resolvedPath = agentPath;

  try {
    const stat = await fs.stat(agentPath);
    if (stat.isDirectory()) {
      resolvedPath = path.join(agentPath, "AGENT.md");
    }
  } catch {
    diagnostics.push({
      severity: "error",
      code: "AGENT_NOT_FOUND",
      message: `Agent not found: ${agentPath}`,
    });
    return { agent: null, diagnostics };
  }

  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf-8");
  } catch {
    diagnostics.push({
      severity: "error",
      code: "AGENT_NOT_FOUND",
      message: `Cannot read agent file: ${resolvedPath}`,
    });
    return { agent: null, diagnostics };
  }

  let parsed: { data: unknown; content: string };
  try {
    parsed = parseYamlFrontMatter(raw);
  } catch (cause) {
    const detail =
      cause instanceof YamlFrontMatterError
        ? cause.message
        : `Front matter must be YAML. ${cause instanceof Error ? cause.message : String(cause)}`;
    return {
      agent: null,
      diagnostics: [
        {
          severity: "error",
          code: "AGENT_FRONT_MATTER_ERROR",
          file: resolvedPath,
          message: `${resolvedPath}: ${detail}`,
        },
      ],
    };
  }
  const frontMatterResult = AgentFrontMatterSchema.safeParse(parsed.data);

  if (!frontMatterResult.success) {
    for (const issue of frontMatterResult.error.issues) {
      diagnostics.push({
        severity: "error",
        code: "AGENT_SCHEMA_ERROR",
        file: resolvedPath,
        message: `${resolvedPath}: ${issue.path.join(".")}: ${issue.message}`,
        path: issue.path.join("."),
      });
    }
    return { agent: null, diagnostics };
  }

  return {
    agent: {
      path: resolvedPath,
      frontMatter: frontMatterResult.data,
      body: parsed.content.trim(),
    },
    diagnostics,
  };
}
