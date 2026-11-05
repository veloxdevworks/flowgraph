/**
 * Detect and apply "merge a router into the human gate before it".
 *
 * A `router` that only repeats a `hitl` answer (`state.decision.choice == 'retry'`)
 * adds a node and a layer of expressions to say what the gate already knows. The
 * same flow is one node with `with.routes`. Core lint recommends the merge and the
 * desktop applies it, so both share these rules.
 *
 * Structural types only: callers pass a `GraphSpec`, the desktop's looser
 * `GraphSpecLite`, or anything shaped like them.
 */

export interface MergeNode {
  id: string;
  type: string;
  with?: Record<string, unknown> | undefined;
}

export type MergeEdge =
  { from: string; to: string | string[] } | { from: string; branch: { to: string }[] };

export interface MergeSpec {
  nodes: MergeNode[];
  edges: MergeEdge[];
}

export type HitlRouteValue = string | { to: string; description?: string };

export type RouterMergePlan = {
  ok: true;
  routerId: string;
  hitlId: string;
  /** The gate's new `with.routes`, one entry per answer. */
  routes: Record<string, HitlRouteValue>;
};

export type RouterMergeRefusal = { ok: false; reason: string };

const DEFAULT_REVIEW_DECISIONS = ["approve", "request-changes"];

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Every answer the gate can give, or undefined when that is not a closed, known set. */
function gateAnswers(w: Record<string, unknown>): string[] | undefined {
  const mode = typeof w["mode"] === "string" ? w["mode"] : "approve";
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  if (mode === "approve") return ["approved", "rejected"];
  if (mode === "choice") {
    const choices = strings(w["choices"]);
    return choices.length > 0 && !choices.some((c) => c.includes("{{")) ? choices : undefined;
  }
  if (mode === "review") {
    const d = strings(w["decision"]);
    return d.length > 0 ? d : DEFAULT_REVIEW_DECISIONS;
  }
  return undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which answer a route's `when` selects, if the condition is a plain comparison of the
 * gate's answer channel — `state.ch.choice == 'x'`, `ch.decision == "x"`, `ch.approved`,
 * `!ch.approved`, `ch.approved == false`. Anything else returns undefined.
 */
export function answerFromCondition(
  when: string,
  channel: string,
  mode: string,
  answers: readonly string[],
): string | undefined {
  let expr = when.replace(/^\s*\{\{|\}\}\s*$/g, "").trim();
  while (/^\(.*\)$/.test(expr) && !/\)\s*[^)]*\(/.test(expr)) expr = expr.slice(1, -1).trim();
  const ch = `(?:state\\.)?${escapeRe(channel)}`;

  if (mode === "approve") {
    if (new RegExp(`^${ch}\\.approved$`).test(expr)) return "approved";
    if (new RegExp(`^!\\s*${ch}\\.approved$`).test(expr)) return "rejected";
    const cmp = expr.match(new RegExp(`^${ch}\\.approved\\s*(==|!=)\\s*(true|false)$`));
    if (cmp) {
      const truthy = (cmp[2] === "true") === (cmp[1] === "==");
      return truthy ? "approved" : "rejected";
    }
    return undefined;
  }

  const field = mode === "review" ? "(?:decision|choice)" : "choice";
  const m = expr.match(new RegExp(`^${ch}\\.${field}\\s*==\\s*(['"])(.*)\\1$`));
  if (m && answers.includes(m[2]!)) return m[2];
  return undefined;
}

function targetsOf(edge: MergeEdge): string[] {
  if ("branch" in edge) return edge.branch.map((b) => b.to);
  return Array.isArray(edge.to) ? edge.to : [edge.to];
}

/** Can `routerId` be folded into the gate before it, and how. */
export function analyzeRouterMerge(
  spec: MergeSpec,
  routerId: string,
): RouterMergePlan | RouterMergeRefusal {
  const no = (reason: string): RouterMergeRefusal => ({ ok: false, reason });
  const router = spec.nodes.find((n) => n.id === routerId);
  if (!router || router.type !== "router") return no(`"${routerId}" is not a router`);

  const rw = router.with ?? {};
  if ((typeof rw["mode"] === "string" ? rw["mode"] : "rules") !== "rules") {
    return no("Only rule-based routers can be merged (model routers decide for themselves).");
  }
  if (rw["match"] === "allMatches") return no("The router can take several routes at once.");
  if (rw["output"] != null)
    return no("The router writes its choice to state, which a gate would not.");
  const routes = asRecord(rw["routes"]);
  if (!routes || Object.keys(routes).length === 0) return no("The router has no routes.");

  // Exactly one node feeds the router, and it is a hitl.
  const feeders = new Set<string>();
  for (const e of spec.edges) if (targetsOf(e).includes(routerId)) feeders.add(e.from);
  for (const n of spec.nodes) {
    if (n.id === routerId) continue;
    const r = asRecord(n.with?.["routes"]);
    if (!r) continue;
    for (const v of Object.values(r)) {
      const to = typeof v === "string" ? v : asRecord(v)?.["to"];
      if (to === routerId) feeders.add(n.id);
    }
  }
  if (feeders.size !== 1) return no("Something other than a single gate leads into the router.");
  const hitlId = [...feeders][0]!;
  const hitl = spec.nodes.find((n) => n.id === hitlId);
  if (!hitl || hitl.type !== "hitl") return no("The node before the router is not a human gate.");

  const hw = hitl.with ?? {};
  const mode = typeof hw["mode"] === "string" ? hw["mode"] : "approve";
  if (hw["routes"] != null) return no(`Gate "${hitlId}" already routes on its answer.`);
  const answers = gateAnswers(hw);
  if (!answers) return no(`Gate "${hitlId}" has no fixed set of answers to route on.`);

  const output = asRecord(hw["output"]);
  const channel = typeof output?.["to"] === "string" ? output["to"] : undefined;
  if (!channel || output?.["map"] != null) {
    return no(`Gate "${hitlId}" does not write its answer to a single channel.`);
  }

  // The gate must lead nowhere but the router.
  for (const e of spec.edges) {
    if (e.from === hitlId && targetsOf(e).some((t) => t !== routerId)) {
      return no(`Gate "${hitlId}" also leads to other nodes.`);
    }
  }

  const out: Record<string, HitlRouteValue> = {};
  let fallback: HitlRouteValue | undefined;
  const value = (route: Record<string, unknown>): HitlRouteValue | undefined => {
    const to = route["to"];
    if (typeof to !== "string" || !to.trim()) return undefined;
    return typeof route["description"] === "string"
      ? { to, description: route["description"] }
      : to;
  };
  for (const [key, raw] of Object.entries(routes)) {
    const route = asRecord(raw);
    const v = route ? value(route) : undefined;
    if (!route || v === undefined) return no(`Route "${key}" has no target.`);
    if (route["default"] === true) {
      fallback ??= v;
      continue;
    }
    if (typeof route["when"] !== "string") return no(`Route "${key}" has no condition.`);
    const answer = answerFromCondition(route["when"], channel, mode, answers);
    if (answer === undefined) {
      return no(
        `Route "${key}" does more than compare the gate's answer (${route["when"].trim()}).`,
      );
    }
    // First match wins, as in the router.
    if (!(answer in out)) out[answer] = v;
  }

  const remaining = answers.filter((a) => !(a in out));
  if (remaining.length > 0) {
    if (fallback === undefined)
      return no(`No route for ${remaining.map((a) => `"${a}"`).join(", ")}.`);
    // Spell the fallback out per answer so the gate stays exhaustive and every answer shows.
    for (const a of remaining) out[a] = fallback;
  }

  // Keep the gate's own answer order.
  const ordered: Record<string, HitlRouteValue> = {};
  for (const a of answers) if (a in out) ordered[a] = out[a]!;
  return { ok: true, routerId, hitlId, routes: ordered };
}

/** Routers that can be merged into their gate. */
export function findMergeableRouters(spec: MergeSpec): { routerId: string; hitlId: string }[] {
  const found: { routerId: string; hitlId: string }[] = [];
  for (const n of spec.nodes) {
    if (n.type !== "router") continue;
    const plan = analyzeRouterMerge(spec, n.id);
    if (plan.ok) found.push({ routerId: plan.routerId, hitlId: plan.hitlId });
  }
  return found;
}

/**
 * Fold the router into its gate: the gate gains `with.routes`, the router node and
 * every edge into or out of it go away.
 */
export function mergeRouterIntoHitl<S extends MergeSpec>(
  spec: S,
  routerId: string,
): { ok: true; spec: S; hitlId: string } | RouterMergeRefusal {
  const plan = analyzeRouterMerge(spec, routerId);
  if (!plan.ok) return plan;

  const nodes = spec.nodes
    .filter((n) => n.id !== routerId)
    .map((n) => {
      if (n.id !== plan.hitlId) return n;
      // Put `routes` just before `output`, where a reader expects the gate's wiring.
      const next: Record<string, unknown> = {};
      let placed = false;
      for (const [k, v] of Object.entries(n.with ?? {})) {
        if (k === "output") {
          next["routes"] = plan.routes;
          placed = true;
        }
        next[k] = v;
      }
      if (!placed) next["routes"] = plan.routes;
      return { ...n, with: next };
    });

  const edges = spec.edges.filter(
    (e) =>
      e.from !== routerId && !(e.from === plan.hitlId && targetsOf(e).every((t) => t === routerId)),
  );
  return { ok: true, spec: { ...spec, nodes, edges }, hitlId: plan.hitlId };
}
