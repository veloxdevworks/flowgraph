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
import type { WorkshopAgendaItem, WorkshopContract, WorkshopResume } from "@flowgraph/spec";
import { applyOutput } from "./output.js";
import { validateJsonSchema } from "../runtime/json-schema.js";
import { collectGitDiff } from "../runtime/git-diff.js";
import { assertHostExecAllowed, nodePolicyOf } from "../node-policy.js";
import { interruptUntilValid } from "../runtime/resume-validation.js";

const configSchema = WorkshopWithSchema;
type Config = z.infer<typeof configSchema>;

export type { WorkshopAgendaItem, WorkshopContract, WorkshopResume } from "@flowgraph/spec";

/** Max git patch bytes embedded in the (checkpointed) interrupt payload. */
export const WORKSHOP_MAX_PATCH_BYTES = 256 * 1024;

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

        const data: WorkshopContract = {
          mode: "workshop",
          agenda,
          fallback,
        };
        if (schema) data.schema = schema;
        if (context !== undefined) data.context = context;
        if (facilitator) data.facilitator = facilitator;
        if (voice) data.voice = voice as WorkshopContract["voice"];
        if (limits) data.limits = limits as WorkshopContract["limits"];

        if (config.artifacts) {
          data.artifactRefs = (renderDeep(config.artifacts, scope) as unknown[]).map(String);
        }

        if (config.diff) {
          await attachDiff(data, config, scope, ctx);
        }

        const result = interruptUntilValid(
          ctx,
          { reason: message, kind: "workshop", data: data as Record<string, unknown> },
          (resume) => mapWorkshopResume(resume, { schema, nodeId: String(nodeSpec["id"]) }),
          { maxAttempts: config.maxResumeAttempts },
        );

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
  data: WorkshopContract,
  config: Config,
  scope: Record<string, unknown>,
  ctx: NodeRunContext,
): Promise<void> {
  const diff = config.diff!;
  if (diff.before != null || diff.after != null) {
    const before = diff.before ? String(renderDeep(diff.before, scope)) : "";
    const after = diff.after ? String(renderDeep(diff.after, scope)) : "";
    data.diff = { before, after };
    data.diffStat = `${before.split("\n").length} → ${after.split("\n").length} lines`;
    return;
  }
  assertHostExecAllowed(nodePolicyOf(ctx), "workshop diff (git)", `workshop node "${ctx.nodeId}"`);
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
    const truncated = Buffer.byteLength(collected.patch, "utf8") > WORKSHOP_MAX_PATCH_BYTES;
    const patch = truncated
      ? Buffer.from(collected.patch, "utf8").subarray(0, WORKSHOP_MAX_PATCH_BYTES).toString("utf8")
      : collected.patch;
    data.diff = { cwd: collected.cwd, base: collected.base, patch, ...(truncated ? { truncated: true } : {}) };
    data.diffStat = collected.stat;
  } catch (err) {
    // Keep diffStat a stat; report the failure on diff.error.
    data.diff = { cwd, error: err instanceof Error ? err.message : String(err) };
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
  const where = `workshop node "${opts.nodeId}" resume`;
  if (!isRecord(resume)) {
    throw new Error(
      `${where} must be an object: { output, transcript?, coverage?, endedReason? } or a bare output object (got ${describeType(resume)}).`,
    );
  }
  const rec = resume;
  const keys = Object.keys(rec);
  const metaKeys = keys.filter((k) => (RESUME_META as readonly string[]).includes(k));
  let output: Record<string, unknown>;
  if ("output" in rec) {
    if (!isRecord(rec["output"])) {
      throw new Error(`${where}: "output" must be an object (got ${describeType(rec["output"])}).`);
    }
    const extra = keys.filter((k) => !(RESUME_META as readonly string[]).includes(k));
    if (extra.length > 0) {
      throw new Error(
        `${where}: unexpected top-level key(s) ${extra.map((k) => `"${k}"`).join(", ")} next to "output". ` +
          `Put output fields inside "output".`,
      );
    }
    output = rec["output"];
  } else if (metaKeys.length > 0 && metaKeys.length < keys.length) {
    // e.g. { title, transcript }: ambiguous, and silently dropping `title` loses data.
    throw new Error(
      `${where} mixes output fields with ${metaKeys.map((k) => `"${k}"`).join(", ")}. ` +
        `Send { output: { ... }, ${metaKeys.join(", ")} } or a bare output object.`,
    );
  } else if (metaKeys.length > 0) {
    output = {};
  } else {
    output = rec;
  }
  validateJsonSchema(output, opts.schema, `workshop node "${opts.nodeId}" output`);

  if ("transcript" in rec && !Array.isArray(rec["transcript"])) {
    throw new Error(`${where}: "transcript" must be an array.`);
  }
  if ("coverage" in rec && !isRecord(rec["coverage"])) {
    throw new Error(`${where}: "coverage" must be an object.`);
  }
  if ("endedReason" in rec && typeof rec["endedReason"] !== "string") {
    throw new Error(`${where}: "endedReason" must be a string.`);
  }
  const transcript = Array.isArray(rec["transcript"]) ? rec["transcript"] : [];
  const coverage = isRecord(rec["coverage"]) ? rec["coverage"] : {};
  const endedReason =
    typeof rec["endedReason"] === "string" && rec["endedReason"]
      ? rec["endedReason"]
      : "completed";

  // transcript/coverage entries are passed through as sent (shape not validated).
  return {
    output,
    transcript: transcript as WorkshopResume["transcript"],
    coverage: coverage as WorkshopResume["coverage"],
    endedReason,
  };
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
