/**
 * Agent resolution: translate a `with.agent` string into a filesystem path.
 *
 * Resolution order:
 *  1. Explicit alias declared in graph config.agents / imports
 *  2. Relative path from the graph's working directory (./agents/foo, agents/foo)
 *  3. Node module resolution (@scope/agent-foo)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";

export interface AgentAliasMap {
  [alias: string]: string;
}

export interface AgentResolverOptions {
  /** Working directory of the graph (usually where the .graph.yaml lives) */
  cwd: string;
  /** Alias map from graph config (alias → path or package name) */
  aliases?: AgentAliasMap;
}

/**
 * Resolve an agent reference to an absolute filesystem path (directory containing AGENT.md).
 * Throws if the resolved path doesn't exist.
 */
export async function resolveAgentPath(uses: string, opts: AgentResolverOptions): Promise<string> {
  const { cwd, aliases = {} } = opts;

  // 1. Explicit alias
  if (uses in aliases) {
    const aliased = aliases[uses]!;
    return resolveAgentPath(aliased, { cwd, aliases: {} });
  }

  // 2. Relative/absolute path (starts with . / ./ ../ or is absolute)
  if (uses.startsWith(".") || uses.startsWith("/") || /^[a-zA-Z]:\\/.test(uses)) {
    const resolved = path.resolve(cwd, uses);
    return findAgentRoot(resolved);
  }

  // 3. Bare path without ./ (e.g. "agents/code-reviewer") — try relative first
  const candidateRelative = path.resolve(cwd, uses);
  try {
    return await findAgentRoot(candidateRelative);
  } catch {
    // Fall through to package resolution
  }

  // 4. Node module / npm package
  try {
    const req = createRequire(path.join(cwd, "package.json"));
    const pkgMain = req.resolve(uses);
    return findAgentRoot(path.dirname(pkgMain));
  } catch {
    throw new Error(
      `Cannot resolve agent "${uses}". ` +
        `Tried: relative path "${candidateRelative}", npm package "${uses}". ` +
        `Check the 'with.agent' value or register an alias in graph imports.`,
    );
  }
}

async function findAgentRoot(candidate: string): Promise<string> {
  // If it directly points to an AGENT.md
  if (candidate.endsWith("AGENT.md")) {
    try {
      await fs.access(candidate);
      return path.dirname(candidate);
    } catch {
      throw new Error(`AGENT.md not found: ${candidate}`);
    }
  }

  // If it's a directory, look for AGENT.md inside
  try {
    const stat = await fs.stat(candidate);
    if (stat.isDirectory()) {
      const agentMd = path.join(candidate, "AGENT.md");
      await fs.access(agentMd);
      return candidate;
    }
  } catch {
    // Not a directory or AGENT.md not found
  }

  throw new Error(`Agent not found at "${candidate}" (no AGENT.md)`);
}
