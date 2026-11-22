/**
 * Built-in hooks:
 *   - `hooksFromSpec` — converts the YAML-bound `runtime.hooks` subset into Hook objects.
 *   - `defaultGuardrailHooks` — overridable defaults (redaction) installed at low priority.
 */

import { hookEventFires, hookVerbAllowed, hookVerbMessage, HOOK_EVENTS } from "@flowgraph/spec";
import type { GraphSpec } from "@flowgraph/spec";
import { createRedactor, DEFAULT_REDACT_PATTERNS } from "../secrets.js";
import type { Hook, HookDirective, HookPhase, HookWhere } from "./types.js";

export const KNOWN_PHASES: ReadonlySet<string> = new Set<string>(HOOK_EVENTS);

export function knownHookDirective(verb: string, on?: string): boolean {
  if (on && hookEventFires(on)) return hookVerbAllowed(on, verb);
  return ["allow", "deny", "interrupt", "retry", "continue", "fail", "redact"].includes(verb)
    || (verb.startsWith("route:") && !!verb.slice(6).trim());
}

/** Map a YAML `do:` verb to a hook directive (or a redaction mutation). */
function directiveFor(
  doVerb: string,
  reason: string | undefined,
  redactor: ((v: unknown) => unknown) | undefined,
): (payload: { update?: Record<string, unknown> }) => HookDirective | void {
  if (doVerb === "allow") return () => undefined;
  if (doVerb === "deny") return () => ({ kind: "veto", reason: reason ?? "denied" });
  if (doVerb === "retry") return () => ({ kind: "retry" });
  if (doVerb === "continue") return () => ({ kind: "continue" });
  if (doVerb === "fail") return () => ({ kind: "fail", reason: reason ?? "fail" });
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
    if (!KNOWN_PHASES.has(entry.on)) throw Object.assign(new Error(`Unknown hook event "${entry.on}".`), {code:"HOOK_PHASE_UNKNOWN",retryable:false});
    if (!knownHookDirective(entry.do, entry.on)) throw Object.assign(new Error(`Hook directive "${entry.do}" is not valid for ${entry.on}. ${hookVerbMessage(entry.on)}`),{code:"HOOK_DIRECTIVE_UNKNOWN",retryable:false});
    const phase = entry.on as HookPhase;
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
