import type { Diagnostic } from "@flowgraph/spec";
import { checkBinOnPath, registry } from "@flowgraph/core";
import { demoNode } from "./demo.js";
import { playwrightProblem } from "./demo-playwright.js";
import { iosToolchainReady } from "./demo-simulator.js";
import { demoToolExposureDiagnostics, provesObjective } from "./validate.js";

async function demoPreflightCheck(
  node: { id?: string; type?: string; with?: unknown },
  path: string,
  cwd: string,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const withBlock = (node.with ?? {}) as Record<string, unknown>;
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
  return diagnostics;
}

/** Register the `demo` node type and its validation/preflight hooks (idempotent). Runs on import. */
export function registerDemoNode(): void {
  if (!registry.has(demoNode.type)) registry.register(demoNode);
  registry.registerValidator("demo-tool-exposure", demoToolExposureDiagnostics, { compile: true });
  registry.registerToolInvokeCheck("demo-objective", (nodeSpec) => {
    if (provesObjective(nodeSpec)) {
      return `node-as-tool: demo node "${String(nodeSpec.id)}" has an objective or steps, so it cannot be called as a tool.`;
    }
    return undefined;
  });
  registry.registerPreflightCheck("demo", demoPreflightCheck);
}

registerDemoNode();

export { demoNode, demoArtifactDir, type DemoResult } from "./demo.js";
export {
  DemoWithSchema,
  DemoStatusSchema,
  DemoStepSchema,
  type DemoWith,
  type DemoStatus,
  type DemoStep,
} from "./schema.js";
export {
  demoManifestPath,
  appendDemoManifestEntry,
  readDemoManifest,
  demoManifestKey,
  type DemoManifestEntry,
  type DemoKind,
  type DemoExtraArtifact,
} from "./demo-manifest.js";
export { provesObjective, demoToolExposureDiagnostics } from "./validate.js";
