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

export const HOOK_WHERE_KEYS = ["nodeId", "nodeType", "tool", "channel"] as const;

const GATE_VERBS = new Set(["allow", "deny", "interrupt"]);
const ERROR_VERBS = new Set(["retry", "continue", "fail"]);

export function hookEventFires(on: string): boolean {
  return (HOOK_EVENTS as readonly string[]).includes(on);
}

export function hookVerbAllowed(on: string, verb: string): boolean {
  if (on === "node:before" || on === "agent:beforeToolCall") return GATE_VERBS.has(verb);
  if (on === "node:error") return ERROR_VERBS.has(verb) || isRouteVerb(verb);
  if (on === "state:beforeUpdate" || on === "node:after") return verb === "redact";
  return false;
}

export function hookVerbMessage(on: string): string {
  if (on === "node:before" || on === "agent:beforeToolCall") return "Use allow, deny or interrupt.";
  if (on === "node:error") return "Use retry, continue, fail or route:<node>.";
  if (on === "state:beforeUpdate" || on === "node:after") return "Use redact.";
  return `Hook event "${on}" does not take a control verb.`;
}

function isRouteVerb(verb: string): boolean {
  return verb.startsWith("route:") && verb.slice("route:".length).trim().length > 0;
}
