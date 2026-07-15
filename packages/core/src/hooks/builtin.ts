/**
 * Built-in hooks:
 *   - `hooksFromSpec` — converts the YAML-bound `runtime.hooks` subset into Hook objects.
 *   - `defaultGuardrailHooks` — overridable defaults (redaction) installed at low priority.
 */

import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { createRedactor, DEFAULT_REDACT_PATTERNS } from "../secrets.js";
import type { Hook, HookDirective, HookPhase, HookWhere } from "./types.js";

/** Legacy hook phase names accepted from YAML and rewritten to canonical. */
const HOOK_PHASE_ALIASES: Readonly<Record<string, HookPhase>> = {
  "intelligent:beforeStep": "agent:beforeStep",
  "intelligent:beforeToolCall": "agent:beforeToolCall",
  "intelligent:afterToolCall": "agent:afterToolCall",
};

const KNOWN_PHASES: ReadonlySet<string> = new Set<string>([
  "run:before", "run:after", "run:error",
  "node:before", "node:after", "node:error",
  "agent:beforeStep", "agent:beforeToolCall", "agent:afterToolCall",
  ...Object.keys(HOOK_PHASE_ALIASES),
  "skill:beforeRun", "skill:afterRun",
  "router:beforeDecision", "router:afterDecision",
  "state:beforeUpdate", "checkpoint:beforeWrite",
  "interrupt:beforeRaise", "interrupt:beforeResume",
]);

/** Map a YAML `do:` verb to a hook directive (or a redaction mutation). */
function directiveFor(
  doVerb: string,
  reason: string | undefined,
  redactor: ((v: unknown) => unknown) | undefined,
): (payload: { update?: Record<string, unknown> }) => HookDirective | void {
  if (doVerb === "retry") return () => ({ kind: "retry" });
  if (doVerb === "continue" || doVerb === "ignore") {
    return () => ({ kind: "veto", reason: reason ?? "continue" });
  }
  if (doVerb === "interrupt") {
    return () => ({ kind: "interrupt", reason: reason ?? "Hook requested approval" });
  }
  if (doVerb.startsWith("route:")) {
    const to = doVerb.slice("route:".length);
    return () => ({ kind: "route", to });
  }
  if (doVerb === "redact") {
    const redact = redactor ?? createRedactor([], DEFAULT_REDACT_PATTERNS);
    return (payload) => {
      if (!payload.update) return;
      return { kind: "mutate", payload: { update: redact(payload.update) as Record<string, unknown> } };
    };
  }
  // "fail" and unknown verbs → no directive (default behavior, i.e. rethrow/observe).
  return () => undefined;
}

export function hooksFromSpec(spec: GraphSpec): Hook[] {
  const entries = spec.runtime?.hooks ?? [];
  const redactPatterns = (spec.runtime?.secrets?.redact?.patterns ?? []).map((p) => {
    try { return new RegExp(p, "gi"); } catch { return null; }
  }).filter((r): r is RegExp => r !== null);
  const redactor = createRedactor([], [...DEFAULT_REDACT_PATTERNS, ...redactPatterns]);

  const hooks: Hook[] = [];
  for (const entry of entries) {
    if (!KNOWN_PHASES.has(entry.on)) continue;
    const phase = (HOOK_PHASE_ALIASES[entry.on] ?? entry.on) as HookPhase;
    const where = entry.where as HookWhere | undefined;
    const resolve = directiveFor(entry.do, entry.reason, redactor);
    hooks.push({
      name: `yaml:${phase}:${entry.do}`,
      phase,
      priority: 50,
      ...(where ? { where } : {}),
      handler: (ctx) => resolve(ctx.payload),
    });
  }
  return hooks;
}

/**
 * Default guardrail hooks. Installed at low priority (high number) so user
 * hooks run first and can pre-empt them; users may override by registering
 * their own or omitting `runtime.secrets.redact`.
 */
export function defaultGuardrailHooks(spec: GraphSpec): Hook[] {
  const hooks: Hook[] = [];
  const redactCfg = spec.runtime?.secrets?.redact;
  if (redactCfg) {
    const extra = (redactCfg.patterns ?? []).map((p) => {
      try { return new RegExp(p, "gi"); } catch { return null; }
    }).filter((r): r is RegExp => r !== null);
    const redact = createRedactor([], [...DEFAULT_REDACT_PATTERNS, ...extra]);
    hooks.push({
      name: "guardrail:redact-state",
      phase: "state:beforeUpdate",
      priority: 900,
      handler: (ctx) => {
        const update = ctx.payload.update;
        if (!update) return;
        return { kind: "mutate", payload: { update: redact(update) as Record<string, unknown> } };
      },
    });
  }
  return hooks;
}
