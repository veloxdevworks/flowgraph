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
import type { Artifact } from "@flowgraph/spec";
import {
  captureFailuresNotice,
  resolveGateArtifacts,
  resolveSelection,
  type HitlSelect,
} from "./hitl-artifacts.js";
import {
  collectGateEvidence,
  evidenceNotice,
  isEvidenceOutput,
  requiredOverride,
  type GateEvidence,
} from "./hitl-evidence.js";
import { ISSUE_CODE } from "../runtime/run-issues.js";
import {
  DEFAULT_REVIEW_DECISIONS,
  hitlOutcomeKey,
  normalizeHitlRoutes,
  resolveHitlRoute,
} from "./hitl-routes.js";

const configSchema = HitlWithSchema;
type Config = z.infer<typeof configSchema>;

const MODE_TO_KIND: Record<Config["mode"], InterruptKind> = {
  approve: "approval",
  question: "question",
  choice: "choice",
  form: "form",
  review: "review",
};

export const hitlNode = defineNode<Config>({
  type: "hitl",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configSchema: configSchema as any,
  capabilities: { interruptible: true, routing: true },

  build(buildCtx: BuildContext, nodeSpec: Record<string, unknown>, config: Config): CompiledNode {
    return {
      contract: {},
      capabilities: { interruptible: true, routing: true },

      async run(state: Record<string, unknown>, ctx: NodeRunContext): Promise<NodeResult> {
        const scope = {
          state,
          input: (ctx as NodeRunContext & { _input?: Record<string, unknown> })._input ?? {},
          config: ctx.config,
          run: ctx.meta,
        };

        let message = stringifyRendered(renderDeep(config.message, scope));
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

        // Artifacts to preview (and optionally pick from) in the modes with a closed answer.
        let presented: Artifact[] = [];
        const select: HitlSelect =
          config.mode === "approve" || config.mode === "choice" || config.mode === "review"
            ? (config.select ?? "none")
            : "none";
        const closedAnswer = config.mode === "approve" || config.mode === "choice" || config.mode === "review";
        const evidenceIds = closedAnswer ? (config.evidence ?? []) : [];
        const outputsNow = state["outputs"] as Record<string, unknown> | undefined;
        if (config.artifacts && closedAnswer) {
          const rendered = config.artifacts.map((a) => renderDeep(a, scope));
          const gate = await resolveGateArtifacts(rendered, ctx.workspace, {
            skipFailure: isEvidenceOutput(evidenceIds, outputsNow),
          });
          presented = gate.artifacts;
          data["artifacts"] = gate.artifacts;
          data["artifactRefs"] = gate.artifactRefs;
          if (gate.captureFailures.length > 0) {
            data["captureFailures"] = gate.captureFailures;
            message = `${message}\n\n${captureFailuresNotice(gate.captureFailures)}`;
          }
          if (select !== "none") data["select"] = select;
        }

        // `with.evidence`: the verdict of each named demo node, read as it stands now.
        let evidence: GateEvidence[] | undefined;
        if (evidenceIds.length > 0) {
          evidence = await collectGateEvidence(evidenceIds, outputsNow, ctx.workspace, (id) => {
            // A node that never ran has no rendered objective, so show the one it declares.
            const objective = (buildCtx.graphNode?.(id)?.with as { objective?: unknown } | undefined)?.objective;
            return typeof objective === "string" && objective.trim() ? objective : null;
          });
          data["evidence"] = evidence;
          // Evidence files are presented like any other, so older clients still show them.
          const seen = new Set(presented.map((a) => a.path));
          const refs = (data["artifactRefs"] as string[] | undefined) ?? [];
          for (const a of evidence.flatMap((e) => e.artifacts)) {
            if (seen.has(a.path)) continue;
            seen.add(a.path);
            presented = [...presented, a];
            if (!refs.includes(a.path)) refs.push(a.path);
          }
          data["artifacts"] = presented;
          data["artifactRefs"] = refs;
          if (select !== "none") data["select"] = select;
          message = `${message}\n\n${evidenceNotice(evidence)}`;
        }

        if (config.mode === "review") {
          const decisions = config.decision?.length ? config.decision : DEFAULT_REVIEW_DECISIONS;
          data["decision"] = decisions;
          data["choices"] = decisions;
          if (config.schema) data["schema"] = renderDeep(config.schema, scope);
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
              select,
              presented,
              evidence,
            }),
          { maxAttempts: config.maxResumeAttempts },
        );

        // Only a gate with evidence builds an override; anywhere else the field was dropped.
        const override = evidence
          ? (result["override"] as { reason: string; items: Array<{ nodeId: string; status: string }> } | null)
          : null;
        if (override) {
          ctx.issue({
            code: ISSUE_CODE.EVIDENCE_OVERRIDDEN,
            severity: "warning",
            message:
              `approved past evidence that does not hold: ` +
              `${override.items.map((i) => `${i.nodeId} (${i.status})`).join(", ")}. Reason: ${override.reason}`,
            impact: "The approval was given without evidence that the objective was met.",
            detail: { override },
          });
        }

        // `round`: 1 for the first accepted answer at this gate, +1 each time it is answered again
        // (a loop back). The previous value is the one this node wrote to `state.outputs.<id>` last
        // time; state is as of the start of the node, so a resumed run re-reads the same value and
        // gets the same round. Rejected answers re-prompt inside interruptUntilValid and never get here.
        const outputs = state["outputs"] as Record<string, { round?: unknown } | undefined> | undefined;
        const prevRound = outputs?.[String(nodeSpec["id"] ?? ctx.nodeId)]?.round;
        const round = (typeof prevRound === "number" && Number.isInteger(prevRound) && prevRound >= 1 ? prevRound : 0) + 1;
        result["round"] = round;

        ctx.emit("node.output", { hitl: { mode: config.mode, result } });

        const update = applyOutput(config.output, result, {
          nodeId: String(nodeSpec["id"] ?? ctx.nodeId),
          scope,
        });

        // `routes`: the answer picks the next node, like a router would.
        const routes = normalizeHitlRoutes(config.routes);
        if (Object.keys(routes).length > 0) {
          const outcome = hitlOutcomeKey(config.mode, result);
          const hit = resolveHitlRoute(routes, outcome);
          if (!hit) {
            throw new Error(
              `hitl node "${String(nodeSpec["id"])}": no route for answer "${outcome}" and no "default" route. ` +
                `Routes: ${Object.keys(routes).join(", ")}.`,
            );
          }
          ctx.emit("router.decision", {
            routes: Object.keys(routes),
            chosen: hit.key,
            to: hit.route.to,
            mode: "hitl",
          });
          return { command: { goto: hit.route.to, update } };
        }

        return { update };
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
    select: HitlSelect;
    presented: Artifact[];
    evidence?: GateEvidence[] | undefined;
  },
): Record<string, unknown> {
  const out = mapAnswer(config, resume, opts);
  if (!opts.evidence) {
    // `override` is the gate's own record, so a client can't plant one through review's merged fields.
    delete out["override"];
    return out;
  }
  // Checked on the finished answer, after the client's fields were merged in, so neither
  // `approved: true` nor `decision: "approve"` can slip past, and `override` is never the client's.
  const mode = config.mode;
  const approving =
    (mode === "approve" || mode === "review") && (out["approved"] === true || (mode === "review" && out["decision"] === "approve"));
  out["override"] = approving
    ? requiredOverride(opts.evidence, resume, { nodeId: opts.nodeId, mode: mode as "approve" | "review" })
    : null;
  return out;
}

function mapAnswer(
  config: Config,
  resume: unknown,
  opts: {
    choices?: string[] | undefined;
    decisions?: string[] | undefined;
    schema?: Record<string, unknown> | undefined;
    nodeId: string;
    select: HitlSelect;
    presented: Artifact[];
  },
): Record<string, unknown> {
  const mode = config.mode;
  const rawSelected =
    resume && typeof resume === "object" && !Array.isArray(resume)
      ? (resume as Record<string, unknown>)["selected"]
      : undefined;
  // The validated records always win over whatever the client sent; `select: none` drops `selected`.
  const withSelection = (out: Record<string, unknown>, required: boolean): Record<string, unknown> => {
    delete out["selected"];
    const picked = resolveSelection(rawSelected, {
      select: opts.select,
      presented: opts.presented,
      required,
      nodeId: opts.nodeId,
    });
    if (picked !== undefined) out["selected"] = picked;
    return out;
  };

  if (mode === "approve") {
    // Only a real `true` approves, so `"yes"` or `1` can't be stored as a truthy approval.
    const approved =
      resume === true ||
      (!!resume && typeof resume === "object" && (resume as { approved?: unknown }).approved === true);
    return withSelection({ approved }, approved);
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
    // The client's other fields are kept, but `decision` is the one matched above (so "1" is stored
    // as the decision it picked) and `approved` is a boolean: a sent `approved: true` still counts.
    const approved = rec["approved"] === undefined ? decision === "approve" : rec["approved"] === true;
    return withSelection(
      {
        ...(feedback != null ? { feedback } : {}),
        ...rec,
        decision,
        approved,
      },
      decision === "approve",
    );
  }

  // choice
  let choice =
    typeof resume === "string"
      ? resume
      : (resume as { choice?: string })?.choice ?? "";
  if (opts.choices?.length && !opts.choices.includes(choice)) {
    const idx = Number(choice) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < opts.choices.length) {
      choice = opts.choices[idx]!;
    }
  }
  if (opts.choices?.length && !opts.choices.includes(choice)) {
    throw new Error(`Invalid choice "${choice}". Expected one of: ${opts.choices.join(", ")}`);
  }
  return withSelection({ choice }, true);
}
