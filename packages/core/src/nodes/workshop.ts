/**
 * Built-in node type: `workshop`
 *
 * One-shot HITL interrupt that hands a client a session contract (agenda,
 * output schema, primed context). The client facilitates the conversation
 * (voice, text, or form) and resumes with a validated structured output.
 */

import * as path from "node:path";
import { z } from "zod";
import { WorkshopWithSchema } from "@flowgraph/spec";
import { renderDeep, stringifyRendered } from "@flowgraph/expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { NodeRunContext } from "../context.js";
import { applyOutput } from "./output.js";
import { validateJsonSchema } from "../runtime/json-schema.js";
import { collectGitDiff } from "../runtime/git-diff.js";

const configSchema = WorkshopWithSchema;
type Config = z.infer<typeof configSchema>;

export type WorkshopAgendaItem = {
  id: string;
  title: string;
  description?: string | undefined;
};

export type WorkshopResume = {
  output: Record<string, unknown>;
  transcript: unknown[];
  coverage: Record<string, unknown>;
  endedReason: string;
};

export const workshopNode = defineNode<Config>({
  type: "workshop",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: { interruptible: true },

  build(_ctx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    return {
      contract: {},
      capabilities: { interruptible: true },

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const scope = {
          state,
          input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
          config: ctx.config,
          run: ctx.meta,
        };

        const message = config.message
          ? stringifyRendered(renderDeep(config.message, scope))
          : "Workshop session";

        const agenda = normalizeAgenda(config.agenda ? renderDeep(config.agenda, scope) : []);
        const schema = config.schema
          ? (renderDeep(config.schema, scope) as Record<string, unknown>)
          : undefined;
        const context = config.context !== undefined ? renderDeep(config.context, scope) : undefined;
        const facilitator = config.facilitator
          ? stringifyRendered(renderDeep(config.facilitator, scope))
          : undefined;
        const voice = config.voice
          ? (renderDeep(config.voice, scope) as Record<string, unknown>)
          : undefined;
        const limits = config.limits
          ? (renderDeep(config.limits, scope) as Record<string, unknown>)
          : undefined;
        const fallback = config.fallback ?? "form";

        const data: Record<string, unknown> = {
          mode: "workshop",
          agenda,
          fallback,
        };
        if (schema) data["schema"] = schema;
        if (context !== undefined) data["context"] = context;
        if (facilitator) data["facilitator"] = facilitator;
        if (voice) data["voice"] = voice;
        if (limits) data["limits"] = limits;

        if (config.artifacts) {
          data["artifactRefs"] = (renderDeep(config.artifacts, scope) as unknown[]).map(String);
        }

        if (config.diff) {
          await attachDiff(data, config, scope, ctx);
        }

        const resume = ctx.interrupt<unknown>({
          reason: message,
          kind: "workshop",
          data,
        });

        const result = mapWorkshopResume(resume, {
          schema,
          nodeId: String(nodeSpec["id"]),
        });

        ctx.emit("node.output", { workshop: result });

        return {
          update: applyOutput(config.output, result, {
            nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
            scope,
          }),
        };
      },
    };
  },
});

export function normalizeAgenda(raw: unknown): WorkshopAgendaItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    if (typeof item === "string") {
      return { id: slugAgenda(item, i), title: item };
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const title = String(rec["title"] ?? rec["id"] ?? `item-${i + 1}`);
      const id = typeof rec["id"] === "string" && rec["id"] ? rec["id"] : slugAgenda(title, i);
      const description =
        typeof rec["description"] === "string" ? rec["description"] : undefined;
      return { id, title, ...(description ? { description } : {}) };
    }
    return { id: `item-${i + 1}`, title: String(item) };
  });
}

function slugAgenda(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || `item-${index + 1}`;
}

async function attachDiff(
  data: Record<string, unknown>,
  config: Config,
  scope: Record<string, unknown>,
  ctx: NodeRunContext,
): Promise<void> {
  const diff = config.diff!;
  if (diff.before != null || diff.after != null) {
    const before = diff.before ? String(renderDeep(diff.before, scope)) : "";
    const after = diff.after ? String(renderDeep(diff.after, scope)) : "";
    data["diff"] = { before, after };
    data["diffStat"] = `${before.split("\n").length} → ${after.split("\n").length} lines`;
    return;
  }
  const cwdRaw = diff.cwd ? String(renderDeep(diff.cwd, scope)) : ctx.workspace;
  const cwd = path.isAbsolute(cwdRaw) ? cwdRaw : path.resolve(ctx.workspace, cwdRaw);
  const base = diff.base ? String(renderDeep(diff.base, scope)) : undefined;
  const paths = diff.paths ? (renderDeep(diff.paths, scope) as string[]) : undefined;
  try {
    const collected = await collectGitDiff({
      cwd,
      ...(base ? { base } : {}),
      ...(paths ? { paths } : {}),
    });
    data["diff"] = { cwd: collected.cwd, base: collected.base, patch: collected.patch };
    data["diffStat"] = collected.stat;
  } catch (err) {
    data["diffStat"] = err instanceof Error ? err.message : String(err);
    data["diff"] = { cwd, error: data["diffStat"] };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const RESUME_META = ["output", "transcript", "coverage", "endedReason"] as const;

export function mapWorkshopResume(
  resume: unknown,
  opts: { schema?: Record<string, unknown> | undefined; nodeId: string },
): WorkshopResume {
  const rec = isRecord(resume) ? resume : {};
  const hasMeta = RESUME_META.some((k) => k in rec);
  const output = isRecord(rec["output"])
    ? rec["output"]
    : hasMeta
      ? {}
      : rec;
  validateJsonSchema(output, opts.schema, `workshop node "${opts.nodeId}" output`);

  const transcript = Array.isArray(rec["transcript"]) ? rec["transcript"] : [];
  const coverage = isRecord(rec["coverage"]) ? rec["coverage"] : {};
  const endedReason =
    typeof rec["endedReason"] === "string" && rec["endedReason"]
      ? rec["endedReason"]
      : "completed";

  return { output, transcript, coverage, endedReason };
}
