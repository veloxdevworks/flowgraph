/**
 * Built-in node type: `hitl`
 *
 * Deterministic human-in-the-loop gate: approval, free-text, choice, JSON form, or review.
 */

import * as path from "node:path";
import { z } from "zod";
import { HitlWithSchema } from "@flowgraph/spec";
import { renderDeep, stringifyRendered } from "@flowgraph/expr";
import { defineNode, type CompiledNode, type BuildContext, type NodeResult } from "../registry.js";
import type { InterruptKind, NodeRunContext } from "../context.js";
import { applyOutput } from "./output.js";
import { validateJsonSchema } from "../runtime/json-schema.js";
import { collectGitDiff } from "../runtime/git-diff.js";
import { assertHostExecAllowed, hostExecAllowed, nodePolicyOf } from "../node-policy.js";
import { interruptUntilValid } from "../runtime/resume-validation.js";

const configSchema = HitlWithSchema;
type Config = z.infer<typeof configSchema>;

const MODE_TO_KIND: Record<Config["mode"], InterruptKind> = {
  approve: "approval",
  question: "question",
  choice: "choice",
  form: "form",
  review: "review",
};

const DEFAULT_REVIEW_DECISIONS = ["approve", "request-changes"];

export const hitlNode = defineNode<Config>({
  type: "hitl",
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

        const message = stringifyRendered(renderDeep(config.message, scope));
        const choices = config.choices
          ? (renderDeep(config.choices, scope) as string[])
          : undefined;

        if (config.mode === "choice" && (!choices || choices.length === 0)) {
          throw new Error(`hitl node "${String(nodeSpec["id"])}": mode "choice" requires non-empty choices.`);
        }

        const data: Record<string, unknown> = { mode: config.mode };
        if (choices) data["choices"] = choices;

        if (config.mode === "form") {
          const schema = config.schema
            ? (renderDeep(config.schema, scope) as Record<string, unknown>)
            : undefined;
          if (schema) data["schema"] = schema;
        }

        if (config.mode === "review") {
          const decisions = config.decision?.length ? config.decision : DEFAULT_REVIEW_DECISIONS;
          data["decision"] = decisions;
          data["choices"] = decisions;
          if (config.schema) data["schema"] = renderDeep(config.schema, scope);
          if (config.artifacts) {
            data["artifactRefs"] = (renderDeep(config.artifacts, scope) as unknown[]).map(String);
          }
          if (config.diff?.before != null || config.diff?.after != null) {
            const before = config.diff.before ? String(renderDeep(config.diff.before, scope)) : "";
            const after = config.diff.after ? String(renderDeep(config.diff.after, scope)) : "";
            data["diff"] = { before, after };
            data["diffStat"] = summarizeInlineDiff(before, after);
          } else if (config.diff || hostExecAllowed(nodePolicyOf(ctx))) {
            // An explicit git diff is refused where host programs are; a
            // review without `diff` just skips the workspace diff there.
            assertHostExecAllowed(nodePolicyOf(ctx), "review diff (git)", `hitl node "${String(nodeSpec["id"])}"`);
            const cwdRaw = config.diff?.cwd
              ? String(renderDeep(config.diff.cwd, scope))
              : ctx.workspace;
            const cwd = path.isAbsolute(cwdRaw) ? cwdRaw : path.resolve(ctx.workspace, cwdRaw);
            const base = config.diff?.base ? String(renderDeep(config.diff.base, scope)) : undefined;
            const paths = config.diff?.paths
              ? (renderDeep(config.diff.paths, scope) as string[])
              : undefined;
            try {
              const diff = await collectGitDiff({
                cwd,
                ...(base ? { base } : {}),
                ...(paths ? { paths } : {}),
              });
              data["diff"] = { cwd: diff.cwd, base: diff.base, patch: diff.patch };
              data["diffStat"] = diff.stat;
            } catch (err) {
              data["diffStat"] = err instanceof Error ? err.message : String(err);
              data["diff"] = { cwd, error: data["diffStat"] };
            }
          }
        }

        const result = interruptUntilValid(
          ctx,
          { reason: message, kind: MODE_TO_KIND[config.mode], data },
          (resume) =>
            mapHitlResume(config, resume, {
              choices,
              decisions: (data["decision"] as string[] | undefined) ?? choices,
              schema: (data["schema"] as Record<string, unknown> | undefined) ?? config.schema,
              nodeId: String(nodeSpec["id"]),
            }),
          { maxAttempts: config.maxResumeAttempts },
        );

        ctx.emit("node.output", { hitl: { mode: config.mode, result } });

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

function summarizeInlineDiff(before: string, after: string): string {
  const b = before.split("\n").length;
  const a = after.split("\n").length;
  return `${b} → ${a} lines`;
}

function mapHitlResume(
  config: Config,
  resume: unknown,
  opts: {
    choices?: string[] | undefined;
    decisions?: string[] | undefined;
    schema?: Record<string, unknown> | undefined;
    nodeId: string;
  },
): Record<string, unknown> {
  const mode = config.mode;

  if (mode === "approve") {
    const approved =
      typeof resume === "boolean"
        ? resume
        : (resume as { approved?: boolean })?.approved ?? false;
    return { approved };
  }

  if (mode === "question") {
    const answer =
      typeof resume === "string"
        ? resume
        : (resume as { answer?: string })?.answer ?? String(resume ?? "");
    return { answer };
  }

  if (mode === "form") {
    const form =
      resume && typeof resume === "object" && !Array.isArray(resume)
        ? (resume as Record<string, unknown>)
        : {};
    validateJsonSchema(form, opts.schema, `hitl node "${opts.nodeId}" form`);
    return { form, ...form };
  }

  if (mode === "review") {
    const rec = resume && typeof resume === "object" && !Array.isArray(resume)
      ? (resume as Record<string, unknown>)
      : { decision: String(resume ?? "") };
    let decision =
      typeof rec["decision"] === "string"
        ? rec["decision"]
        : typeof rec["choice"] === "string"
          ? rec["choice"]
          : typeof resume === "string"
            ? resume
            : rec["approved"] === true
              ? "approve"
              : rec["approved"] === false
                ? "request-changes"
                : "";
    const decisions = opts.decisions ?? DEFAULT_REVIEW_DECISIONS;
    if (decisions.length && !decisions.includes(decision)) {
      const idx = Number(decision) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < decisions.length) {
        decision = decisions[idx]!;
      }
    }
    if (decisions.length && !decisions.includes(decision)) {
      throw new Error(
        `hitl node "${opts.nodeId}": invalid review decision "${decision}". Expected one of: ${decisions.join(", ")}`,
      );
    }
    if (opts.schema) {
      validateJsonSchema(rec, opts.schema, `hitl node "${opts.nodeId}" review`);
    }
    const feedback =
      typeof rec["feedback"] === "string"
        ? rec["feedback"]
        : typeof rec["notes"] === "string"
          ? rec["notes"]
          : undefined;
    return {
      decision,
      approved: decision === "approve",
      ...(feedback != null ? { feedback } : {}),
      ...rec,
    };
  }

  // choice: a string or number answer, bare or as `{ choice }`. A number is
  // read as a 1-based index, the same as its string form.
  const raw = resume !== null && typeof resume === "object" ? (resume as { choice?: unknown }).choice : resume;
  let choice = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
  if (opts.choices?.length && !opts.choices.includes(choice)) {
    const idx = Number(choice) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < opts.choices.length) {
      choice = opts.choices[idx]!;
    }
  }
  if (opts.choices?.length && !opts.choices.includes(choice)) {
    throw new Error(`Invalid choice "${choice}". Expected one of: ${opts.choices.join(", ")}`);
  }
  return { choice };
}
