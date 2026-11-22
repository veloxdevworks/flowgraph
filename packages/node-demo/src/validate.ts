import type { Diagnostic, GraphSpec, NodeSpec } from "@flowgraph/spec";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A `demo` node that proves something can't be an agent tool (ADR-0019 §9): a tool call writes
 * no `state.outputs`, and an agent choosing its own assertions would make `passed` meaningless.
 */
export function provesObjective(node: { type?: unknown; with?: unknown } | undefined): boolean {
  if (node?.type !== "demo") return false;
  const w = (node.with ?? {}) as Record<string, unknown>;
  return w["objective"] != null || w["steps"] != null;
}

export function demoToolExposureDiagnostics(spec: GraphSpec): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const check = (node: NodeSpec, path: string): void => {
    const w = (node.with ?? {}) as { tools?: unknown; node?: NodeSpec };
    if (Array.isArray(w.tools)) {
      for (const tool of w.tools as Array<{ node?: unknown }>) {
        const target = (Array.isArray(spec.nodes) ? spec.nodes : []).find((n) => n != null && n.id === tool?.node);
        if (!provesObjective(target)) continue;
        diagnostics.push({
          severity: "error",
          code: "DEMO_OBJECTIVE_AS_TOOL",
          message: `Node "${node.id ?? "map item"}" exposes demo node "${target!.id}" as a tool, but a demo node with an objective or steps can't be an agent tool`,
          path: `${path}.with.tools`,
        });
      }
    }
    if (w.node) check(w.node, `${path}.with.node`);
  };
  for (const node of Array.isArray(spec.nodes) ? spec.nodes : []) {
    if (!isRecord(node)) continue;
    check(node as NodeSpec, `nodes.${String(node.id)}`);
  }
  return diagnostics;
}
