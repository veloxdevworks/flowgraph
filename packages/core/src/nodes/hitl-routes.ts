/**
 * `hitl` routing: a human's answer picks the next node, so a gate needs no router
 * after it. Shared by the node (to route at run time), the compiler (to declare the
 * possible destinations) and graph lint (to check every outcome has a route).
 */

export type HitlRoute = { to: string; description?: string };

/** Review decisions used when a `review` hitl lists none. */
export const DEFAULT_REVIEW_DECISIONS = ["approve", "request-changes"];

/** Route key that catches any outcome without its own route. */
export const HITL_DEFAULT_ROUTE = "default";

/** Normalise `with.routes` (string or `{ to }` values) into `{ to }` entries; junk is dropped. */
export function normalizeHitlRoutes(raw: unknown): Record<string, HitlRoute> {
  const out: Record<string, HitlRoute> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (value.trim()) out[key] = { to: value };
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const v = value as Record<string, unknown>;
      if (typeof v["to"] === "string" && v["to"].trim()) {
        out[key] = {
          to: v["to"],
          ...(typeof v["description"] === "string" ? { description: v["description"] } : {}),
        };
      }
    }
  }
  return out;
}

export type HitlOutcomes = {
  /** Every answer the human can give, when known before the run. */
  outcomes: string[];
  /** Some outcome names come from a template, so they are only known at run time. */
  dynamic: boolean;
};

/** The outcomes a hitl can produce, or undefined for modes that cannot route (`question`, `form`). */
export function hitlOutcomes(withBlock: Record<string, unknown>): HitlOutcomes | undefined {
  const mode = typeof withBlock["mode"] === "string" ? withBlock["mode"] : "approve";
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const templated = (list: string[]) => list.some((x) => x.includes("{{"));
  if (mode === "approve") return { outcomes: ["approved", "rejected"], dynamic: false };
  if (mode === "choice") {
    const choices = strings(withBlock["choices"]);
    const isTemplate = typeof withBlock["choices"] === "string" || templated(choices);
    return { outcomes: choices.filter((c) => !c.includes("{{")), dynamic: isTemplate || choices.length === 0 };
  }
  if (mode === "review") {
    const decisions = strings(withBlock["decision"]);
    return { outcomes: decisions.length ? decisions : DEFAULT_REVIEW_DECISIONS, dynamic: false };
  }
  return undefined;
}

/** Which outcome a mapped answer represents. */
export function hitlOutcomeKey(mode: string, result: Record<string, unknown>): string {
  if (mode === "approve") return result["approved"] === true ? "approved" : "rejected";
  if (mode === "review") return String(result["decision"] ?? "");
  if (mode === "choice") return String(result["choice"] ?? "");
  return "";
}

/** The route for an outcome: its own entry, else `default`. */
export function resolveHitlRoute(
  routes: Record<string, HitlRoute>,
  outcome: string,
): { key: string; route: HitlRoute } | undefined {
  const own = Object.prototype.hasOwnProperty.call(routes, outcome) ? routes[outcome] : undefined;
  if (own) return { key: outcome, route: own };
  const fallback = routes[HITL_DEFAULT_ROUTE];
  return fallback ? { key: HITL_DEFAULT_ROUTE, route: fallback } : undefined;
}

/** Destination node ids declared by `with.routes`, in declaration order, without repeats. */
export function hitlRouteTargets(withBlock: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  for (const r of Object.values(normalizeHitlRoutes(withBlock["routes"]))) seen.add(r.to);
  return [...seen];
}
