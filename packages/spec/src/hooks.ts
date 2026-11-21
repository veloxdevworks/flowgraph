/**
 * Hook events the runtime actually runs, and the verbs each one accepts.
 *
 * Gate events can allow, deny, or interrupt. Error events can retry, continue,
 * fail, or route. Redaction is limited to the two events that see a state delta.
 */

export const HOOK_EVENTS = [
  "run:before",
  "run:after",
  "run:error",
  "node:before",
  "node:after",
  "node:error",
  "agent:beforeToolCall",
  "agent:afterToolCall",
  "interrupt:beforeRaise",
  "interrupt:beforeResume",
  "state:beforeUpdate",
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Names that still parse, rewritten to an event that runs. */
export const HOOK_EVENT_ALIASES: Readonly<Record<string, HookEventName>> = {
  "intelligent:beforeToolCall": "agent:beforeToolCall",
  "intelligent:afterToolCall": "agent:afterToolCall",
};

export const HOOK_WHERE_KEYS = ["nodeId", "nodeType", "tool", "channel"] as const;

const GATE_VERBS = new Set(["allow", "deny", "interrupt"]);
const ERROR_VERBS = new Set(["retry", "continue", "fail"]);

export function canonicalHookEvent(on: string): string {
  return HOOK_EVENT_ALIASES[on] ?? on;
}

export function hookEventFires(on: string): boolean {
  return (HOOK_EVENTS as readonly string[]).includes(canonicalHookEvent(on));
}

export function hookVerbAllowed(on: string, verb: string): boolean {
  const event = canonicalHookEvent(on);
  if (event === "node:before" || event === "agent:beforeToolCall") return GATE_VERBS.has(verb);
  if (event === "node:error") return ERROR_VERBS.has(verb) || isRouteVerb(verb);
  if (event === "state:beforeUpdate" || event === "node:after") return verb === "redact";
  return false;
}

export function hookVerbMessage(on: string): string {
  const event = canonicalHookEvent(on);
  if (event === "node:before" || event === "agent:beforeToolCall") return "Use allow, deny or interrupt.";
  if (event === "node:error") return "Use retry, continue, fail or route:<node>.";
  if (event === "state:beforeUpdate" || event === "node:after") return "Use redact.";
  return `Hook event "${event}" does not take a control verb.`;
}

function isRouteVerb(verb: string): boolean {
  return verb.startsWith("route:") && verb.slice("route:".length).trim().length > 0;
}
