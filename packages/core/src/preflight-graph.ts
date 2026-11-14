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
import { subgraphAliases } from "./runtime/graph-files.js";
import { checkBinOnPath } from "./runtime/which.js";
import { playwrightProblem } from "./nodes/demo-playwright.js";
import { iosToolchainReady } from "./nodes/demo-simulator.js";
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
    const graphAliases = { ...(graph === spec ? aliases : {}), ...Object.fromEntries((graph.imports ?? []).flatMap((imp) => "skill" in imp ? [[imp.as ?? imp.skill, imp.skill]] : [])) };
    for (const ref of discoverSkillUses(graph)) {
      let skillDir: string;
      try {
        skillDir = await resolveSkillPath(ref, { cwd, aliases: graphAliases });
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

    const childAliases = subgraphAliases(graph);
    for (const ref of discoverSubgraphFileUses(graph)) {
      const file = childAliases[ref] ?? ref;
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
    const graphAliases = { ...(graph === spec ? aliases : {}), ...Object.fromEntries((graph.imports ?? []).flatMap((imp) => "agent" in imp ? [[imp.as ?? imp.agent, imp.agent]] : [])) };
    for (const ref of discoverAgentUses(graph)) {
      let agentDir: string;
      try {
        agentDir = await resolveAgentPath(ref, { cwd, aliases: graphAliases });
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

    const childAliases = subgraphAliases(graph);
    for (const ref of discoverSubgraphFileUses(graph)) {
      const file = childAliases[ref] ?? ref;
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
 * Preflight `requires` on shell/script nodes, and the tools `demo` nodes capture with.
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
      jobs.push(checkNodeRequires(node, p, diagnostics, cwd));
    }, prefix);
    await Promise.all(jobs);

    const childAliases = subgraphAliases(graph);
    for (const ref of discoverSubgraphFileUses(graph)) {
      const file = childAliases[ref] ?? ref;
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

async function checkNodeRequires(
  node: NodeSpec,
  path: string,
  diagnostics: Diagnostic[],
  cwd: string,
): Promise<void> {
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

  if (node.type === "demo") {
    // A required capture fails the run at the end, so catch it before the run starts.
    const strict = withBlock["strict"] === true;
    const report = (message: string, at: string): void => {
      diagnostics.push({
        severity: strict ? "error" : "warning",
        code: strict ? "BIN_NOT_FOUND" : "BIN_NOT_FOUND_OPTIONAL",
        message: `demo node "${node.id}": ${message}${strict ? "" : " (capture will degrade)"}`,
        path: at,
      });
    };

    const sim = withBlock["simulator"] as { platform?: string } | undefined;
    if (sim && typeof sim === "object") {
      if (sim.platform === "ios" && !(await iosToolchainReady())) {
        report("simulator.ios needs simctl, which ships with Xcode", `${path}.with.simulator`);
      }
      if (sim.platform === "android" && !(await checkBinOnPath("adb"))) {
        report('simulator.android needs "adb" on PATH', `${path}.with.simulator`);
      }
    }

    const browserMode = withBlock["screenshot"]
      ? "screenshot"
      : withBlock["video"]
        ? "video"
        : withBlock["steps"]
          ? "steps"
          : undefined;
    if (browserMode) {
      const shot = withBlock["screenshot"] as { video?: unknown } | undefined;
      const problem = await playwrightProblem(cwd, { video: browserMode !== "screenshot" || Boolean(shot?.video) });
      if (problem) report(problem, `${path}.with.${browserMode}`);
    }
  }
}

