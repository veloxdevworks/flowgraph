/** Topology (ADR-0020 §4): which targets exist and how to reach them. Supplied by the host, never the graph. */

import { z } from "zod";
import { PlacementLabelSchema, type Diagnostic } from "@flowgraph/spec";
import { CustomLabelsConfigSchema, type CustomLabelsConfig } from "./labels.js";

/** Same rule as node ids. */
export const TARGET_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const TargetSchema = z
  .object({
    url: z.string().url(),
    token: z.string().min(1).optional().describe('Literal token or "env:NAME"'),
    labels: z.array(PlacementLabelSchema).optional().describe("Static hint; live labels come from the worker"),
  })
  .strict();

export const TopologySchema = z
  .object({
    targets: z
      .record(TargetSchema)
      .superRefine((rec, ctx) => {
        for (const name of Object.keys(rec)) {
          if (!TARGET_NAME_PATTERN.test(name)) {
            ctx.addIssue({ code: "custom", path: [name], message: `target name "${name}" must start with a letter and use letters, digits, _ or -` });
          }
        }
      })
      .optional(),
    local: z.object({ labels: CustomLabelsConfigSchema.optional() }).strict().optional(),
  })
  .strict();

export interface TopologyTarget {
  url: string;
  token?: string;
  labels?: string[];
}

export interface Topology {
  targets?: Record<string, TopologyTarget>;
  local?: { labels?: CustomLabelsConfig };
}

export function parseTopology(input: unknown): { topology: Topology; diagnostics: Diagnostic[] } {
  const r = TopologySchema.safeParse(input ?? {});
  if (r.success) return { topology: r.data as Topology, diagnostics: [] };
  return {
    topology: {},
    diagnostics: r.error.issues.map((i) => ({
      severity: "error" as const,
      code: "TOPOLOGY_INVALID",
      message: i.message,
      path: i.path.join("."),
    })),
  };
}

/** Resolve a target's token: `env:NAME` reads `env[NAME]`; anything else is literal. */
export function resolveTargetToken(
  target: Pick<TopologyTarget, "token">,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const t = target.token;
  if (t === undefined) return undefined;
  if (!t.startsWith("env:")) return t;
  const name = t.slice(4);
  const v = env[name];
  if (v === undefined || v === "") throw new Error(`Target token env var "${name}" is not set`);
  return v;
}
