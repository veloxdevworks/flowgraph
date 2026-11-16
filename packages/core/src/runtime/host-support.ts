import type { Diagnostic, GraphSpec } from "@flowgraph/spec";

export interface HostSupportOptions {
  /** When true, this host starts runs from `triggers` (Flowgraph Desktop). */
  interpretsTriggers?: boolean;
  /** Name used in the warning, e.g. "flowgraph CLI". */
  hostName: string;
}

/**
 * Warnings for graph features this host does not interpret. Triggers stay in
 * the schema because Desktop uses them; CLI, server, and compiled.run() warn.
 */
export function hostSupportDiagnostics(spec: GraphSpec, host: HostSupportOptions): Diagnostic[] {
  if (host.interpretsTriggers) return [];
  const triggers = spec.triggers ?? [];
  if (triggers.length === 0) return [];
  const n = triggers.length;
  return [
    {
      severity: "warning",
      code: "TRIGGERS_HOST_UNSUPPORTED",
      path: "triggers",
      message:
        `${host.hostName} does not start runs from triggers; this graph's ${n} trigger${n === 1 ? "" : "s"} will be ignored. ` +
        "Use a host that interprets them, such as Flowgraph Desktop.",
    },
  ];
}
