/**
 * Hooks — interception points that can observe AND influence execution.
 *
 * Events tell you what happened; hooks let you change what happens.
 * Hooks run at defined lifecycle phases, are ordered by priority, and the
 * first veto/route/retry/interrupt directive wins; mutations chain.
 */

import type { RunMeta } from "../context.js";

export type HookPhase =
  | "run:before"
  | "run:after"
  | "run:error"
  | "node:before"
  | "node:after"
  | "node:error"
  | "intelligent:beforeStep"
  | "intelligent:beforeToolCall"
  | "intelligent:afterToolCall"
  | "skill:beforeRun"
  | "skill:afterRun"
  | "router:beforeDecision"
  | "router:afterDecision"
  | "state:beforeUpdate"
  | "checkpoint:beforeWrite"
  | "interrupt:beforeRaise"
  | "interrupt:beforeResume";

/** Selector to scope a hook to certain nodes/tools/channels. */
export interface HookWhere {
  nodeId?: string;
  nodeType?: string;
  tool?: string;
  channel?: string;
}

/** Phase-specific payload passed to (and mutated by) hooks. */
export interface HookPayload {
  nodeId?: string;
  nodeType?: string;
  /** node:before / run:before — the input/initial state. */
  input?: Record<string, unknown>;
  /** node:after / state:beforeUpdate — the state delta. */
  update?: Record<string, unknown>;
  /** intelligent:*ToolCall — tool name + args/result. */
  tool?: string;
  args?: unknown;
  result?: unknown;
  /** node:error / run:error — the error. */
  error?: Error;
  /** router:*Decision — chosen route. */
  route?: string;
  /** interrupt:* — reason/payload. */
  reason?: string;
  interruptPayload?: unknown;
  [key: string]: unknown;
}

export interface HookContext {
  phase: HookPhase;
  state: Readonly<Record<string, unknown>>;
  run: RunMeta;
  payload: HookPayload;
}

export type HookDirective =
  | { kind: "mutate"; payload: Partial<HookPayload> }
  | { kind: "veto"; reason: string }
  | { kind: "retry"; delayMs?: number }
  | { kind: "route"; to: string }
  | { kind: "interrupt"; reason: string; payload?: unknown };

export type HookResult = void | HookDirective;

export interface Hook {
  name?: string;
  phase: HookPhase;
  /** Lower runs first. Default 100. */
  priority?: number;
  where?: HookWhere;
  handler: (ctx: HookContext) => HookResult | Promise<HookResult>;
}
