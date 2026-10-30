/**
 * Upfront skill/agent preflight: resolve SKILL.md / AGENT.md refs and check readiness.
 */

import { loadSkill, preflightSkill, formatPreflightReport } from "@flowgraph/skills";
import type { Diagnostic } from "@flowgraph/spec";
import type { GraphSpec } from "@flowgraph/spec";
import * as path from "node:path";
import { resolveSkillPath } from "./skill-resolver.js";
import { resolveAgentPath } from "./agent-resolver.js";
import { discoverSkillUses, discoverSubgraphFileUses } from "./discover-skills.js";
import { discoverAgentUses } from "./discover-agents.js";
import { loadAgentDef } from "./agents/loader.js";
import { loadGraph } from "./loader.js";
import { checkBinOnPath } from "./runtime/which.js";
import type { NodeSpec } from "@flowgraph/spec";

export interface PreflightGraphOptions {
  cwd: string;
  skillAliases?: Record<string, string>;
  agentAliases?: Record<string, string>;
}

export interface PreflightGraphResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  report: string;
}

/**
 * Preflight all skill nodes referenced by a graph before execution.
 */
export async function preflightGraphSkills(
  spec: GraphSpec,
  opts: PreflightGraphOptions,
): Promise<PreflightGraphResult> {
  const aliases = opts.skillAliases ?? {};
  const diagnostics: Diagnostic[] = [];
  const reportRows: Parameters<typeof formatPreflightReport>[0] = [];
  const visited = new Set<string>();

  const walk = async (graph: GraphSpec, cwd: string): Promise<void> => {
    for (const ref of discoverSkillUses(graph)) {
      let skillDir: string;
      try {
        skillDir = await resolveSkillPath(ref, { cwd, aliases });
      } catch (err) {
        diagnostics.push({
          severity: "error",
          code: "SKILL_NOT_FOUND",
          message: `skill "${ref}": ${String(err)}`,
        });
        continue;
      }

      const { skill, diagnostics: loadDiags } = await loadSkill(skillDir);
      diagnostics.push(...loadDiags);
      if (!skill) continue;

      const result = await preflightSkill(skill);
      diagnostics.push(...result.diagnostics);
      reportRows.push({ skill, result });
    }

    const subgraphAliases = (graph.config as { subgraphs?: Record<string, string> } | undefined)?.subgraphs ?? {};
    for (const ref of discoverSubgraphFileUses(graph)) {
      const file = subgraphAliases[ref] ?? ref;
      const resolved = path.resolve(cwd, file);
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      const loaded = await loadGraph(file, { cwd });
      if (!loaded.spec) {
        diagnostics.push(...loaded.diagnostics);
        continue;
      }
      await walk(loaded.spec, path.dirname(resolved));
    }
  };

  await walk(spec, opts.cwd);

  const ok = diagnostics.every((d) => d.severity !== "error");
  const report = reportRows.length > 0 ? formatPreflightReport(reportRows) : "";
  return { ok, diagnostics, report };
}

/**
 * Preflight all agent-definition refs (`with.agent`) before execution.
 */
export async function preflightGraphAgents(
  spec: GraphSpec,
  opts: PreflightGraphOptions,
): Promise<PreflightGraphResult> {
  const aliases = opts.agentAliases ?? {};
  const diagnostics: Diagnostic[] = [];
  const visited = new Set<string>();

  const walk = async (graph: GraphSpec, cwd: string): Promise<void> => {
    for (const ref of discoverAgentUses(graph)) {
      let agentDir: string;
      try {
        agentDir = await resolveAgentPath(ref, { cwd, aliases });
      } catch (err) {
        diagnostics.push({
          severity: "error",
          code: "AGENT_NOT_FOUND",
          message: `agent "${ref}": ${String(err)}`,
        });
        continue;
      }

      const { diagnostics: loadDiags } = await loadAgentDef(agentDir);
      diagnostics.push(...loadDiags);
    }

    const subgraphAliases = (graph.config as { subgraphs?: Record<string, string> } | undefined)?.subgraphs ?? {};
    for (const ref of discoverSubgraphFileUses(graph)) {
      const file = subgraphAliases[ref] ?? ref;
      const resolved = path.resolve(cwd, file);
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      const loaded = await loadGraph(file, { cwd });
      if (!loaded.spec) {
        diagnostics.push(...loaded.diagnostics);
        continue;
      }
      await walk(loaded.spec, path.dirname(resolved));
    }
  };

  await walk(spec, opts.cwd);

  const ok = diagnostics.every((d) => d.severity !== "error");
  return { ok, diagnostics, report: "" };
}

function walkRequireNodes(graph: GraphSpec, visit: (node: NodeSpec, path: string) => void, prefix = ""): void {
  for (const [i, node] of graph.nodes.entries()) {
    const p = `${prefix}nodes[${i}]`;
    visit(node, p);
    if (node.type === "map") {
      const inner = (node.with as { node?: NodeSpec } | undefined)?.node;
      if (inner && typeof inner === "object" && "type" in inner) {
        visit(inner as NodeSpec, `${p}.with.node`);
      }
    }
  }
}

/**
 * Preflight `requires` on shell/script nodes and demo simulator toolchains.
 */
export async function preflightGraphRequires(
  spec: GraphSpec,
  opts: PreflightGraphOptions,
): Promise<PreflightGraphResult> {
  const diagnostics: Diagnostic[] = [];
  const visited = new Set<string>();

  const walk = async (graph: GraphSpec, cwd: string, prefix = ""): Promise<void> => {
    const jobs: Promise<void>[] = [];
    walkRequireNodes(graph, (node, p) => {
      jobs.push(checkNodeRequires(node, p, diagnostics));
    }, prefix);
    await Promise.all(jobs);

    const subgraphAliases = (graph.config as { subgraphs?: Record<string, string> } | undefined)?.subgraphs ?? {};
    for (const ref of discoverSubgraphFileUses(graph)) {
      const file = subgraphAliases[ref] ?? ref;
      const resolved = path.resolve(cwd, file);
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      const loaded = await loadGraph(file, { cwd });
      if (!loaded.spec) {
        diagnostics.push(...loaded.diagnostics);
        continue;
      }
      await walk(loaded.spec, path.dirname(resolved), `${prefix}${ref}.`);
    }
  };

  await walk(spec, opts.cwd);
  const ok = diagnostics.every((d) => d.severity !== "error");
  return { ok, diagnostics, report: diagnostics.map((d) => `${d.severity}: ${d.message}`).join("\n") };
}

async function checkNodeRequires(node: NodeSpec, path: string, diagnostics: Diagnostic[]): Promise<void> {
  const withBlock = (node.with ?? {}) as Record<string, unknown>;
  const requires = Array.isArray(withBlock["requires"]) ? (withBlock["requires"] as Array<{ bin?: string; version?: string }>) : [];
  const onMissing = withBlock["onMissingTool"] === "skip" ? "skip" : "fail";

  for (const req of requires) {
    const bin = typeof req?.bin === "string" ? req.bin : "";
    if (!bin) continue;
    const onPath = await checkBinOnPath(bin);
    if (onPath) continue;
    diagnostics.push({
      severity: onMissing === "skip" ? "warning" : "error",
      code: onMissing === "skip" ? "BIN_NOT_FOUND_OPTIONAL" : "BIN_NOT_FOUND",
      message: onMissing === "skip"
        ? `node "${node.id}" optional binary "${bin}" not found on PATH (onMissingTool: skip)`
        : `node "${node.id}" requires "${bin}" on PATH`,
      path,
    });
  }

  const sim = withBlock["simulator"] as { platform?: string } | undefined;
  if (node.type === "demo" && sim && typeof sim === "object") {
    const bin = sim.platform === "android" ? "adb" : sim.platform === "ios" ? "xcrun" : undefined;
    if (bin && !(await checkBinOnPath(bin))) {
      diagnostics.push({
        severity: "warning",
        code: "BIN_NOT_FOUND_OPTIONAL",
        message: `demo node "${node.id}" simulator.${sim.platform} needs "${bin}" on PATH (capture will degrade)`,
        path: `${path}.with.simulator`,
      });
    }
  }
}

