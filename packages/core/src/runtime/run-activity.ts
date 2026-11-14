import { renderDeep } from "@flowgraph/expr";

export type RunPhase =
  "ready" | "running" | "interrupted" | "paused" | "completed" | "failed" | "aborted";
export type RunWaitingOn = "you" | "external" | "both" | "unknown" | null;

/** Compact structural progress, safe to list without sending run state or interrupt bodies. */
export interface RunActivity {
  phase: RunPhase;
  currentNodes: string[];
  waitingOn: RunWaitingOn;
  stateSince: string;
}

type PendingInterrupt = { kind?: string; payload?: unknown };
type ActivityEvent = {
  type: string;
  ts: string;
  scope?: { nodeId?: string; parentSpanId?: string };
  data?: unknown;
};

export function runPhase(status: string): RunPhase {
  if (status === "error" || status === "failed") return "failed";
  if (status === "cancelled" || status === "aborted") return "aborted";
  if (["ready", "interrupted", "paused", "completed"].includes(status)) return status as RunPhase;
  return "running";
}

export function isActiveRun(status: string): boolean {
  return ["ready", "started", "running", "paused", "interrupted"].includes(status);
}

export function initialRunActivity(status: string, at: string): RunActivity {
  const phase = runPhase(status);
  return {
    phase,
    currentNodes: [],
    stateSince: validTime(at),
    waitingOn:
      phase === "interrupted" ? "unknown" : phase === "paused" || phase === "ready" ? "you" : null,
  };
}

function validTime(at: string): string {
  return Number.isFinite(Date.parse(at)) ? at : new Date(0).toISOString();
}

function nodes(values: unknown): string[] {
  return Array.isArray(values)
    ? [
        ...new Set(
          values
            .filter((value): value is string => typeof value === "string" && value.length > 0)
            .slice(0, 256),
        ),
      ].sort()
    : [];
}

function transition(
  previous: RunActivity,
  phase: RunPhase,
  currentNodes: string[],
  waitingOn: RunWaitingOn,
  at: string,
): RunActivity {
  if (
    previous.phase === phase &&
    previous.waitingOn === waitingOn &&
    previous.currentNodes.length === currentNodes.length &&
    previous.currentNodes.every((value, index) => value === currentNodes[index])
  )
    return previous;
  return { phase, currentNodes, waitingOn, stateSince: validTime(at) };
}

export function waitingOnInterrupts(interrupts: readonly PendingInterrupt[]): RunWaitingOn {
  if (!interrupts.length) return "unknown";
  const kinds = new Set(
    interrupts.map((interrupt) =>
      interrupt.kind === "custom"
        ? "external"
        : ["approval", "question", "choice", "form", "review", "workshop"].includes(
              interrupt.kind ?? "",
            )
          ? "you"
          : "unknown",
    ),
  );
  if (kinds.has("you") && kinds.has("external")) return "both";
  if (kinds.has("unknown")) return "unknown";
  return kinds.has("you") ? "you" : "external";
}

function interruptNodes(interrupts: readonly PendingInterrupt[]): string[] {
  return nodes(
    interrupts.map((interrupt) => {
      const payload = interrupt.payload as { data?: { __nodeId?: unknown } } | undefined;
      return payload?.data?.__nodeId;
    }),
  );
}

/** Use a read-only checkpoint snapshot to describe paused/interrupt locations precisely. */
export function settleRunActivity(
  previous: RunActivity,
  status: string,
  at: string,
  snapshot?: { next?: readonly string[]; interrupts?: readonly PendingInterrupt[] } | null,
): RunActivity {
  const phase = runPhase(status);
  if (phase === "interrupted") {
    const pending = snapshot?.interrupts ?? [];
    const next = nodes(snapshot?.next);
    return transition(
      previous,
      phase,
      next.length ? next : interruptNodes(pending),
      waitingOnInterrupts(pending),
      at,
    );
  }
  if (phase === "paused") return transition(previous, phase, nodes(snapshot?.next), "you", at);
  return transition(previous, phase, [], phase === "ready" ? "you" : null, at);
}

/** Ignore nested graph lifecycles, retries, token traffic, and unchanged observations. */
export function updateRunActivity(
  previous: RunActivity,
  event: ActivityEvent,
  declaredNodeIds?: readonly string[],
): RunActivity {
  if (event.scope?.parentSpanId) return previous;
  const data = event.data as { interrupts?: PendingInterrupt[]; next?: string[] } | undefined;
  if (["run.start", "run.continued", "interrupt.resumed"].includes(event.type)) {
    return transition(previous, "running", [], null, event.ts);
  }
  if (
    event.type === "interrupt.raised" &&
    Array.isArray(data?.interrupts) &&
    data.interrupts.length
  ) {
    return settleRunActivity(previous, "interrupted", event.ts, { interrupts: data.interrupts });
  }
  const terminal = {
    "run.end": "completed",
    "run.error": "failed",
    "run.aborted": "aborted",
    "run.paused": "paused",
  } as const;
  if (event.type in terminal)
    return settleRunActivity(
      previous,
      terminal[event.type as keyof typeof terminal],
      event.ts,
      data,
    );
  const nodeId = event.scope?.nodeId;
  if (!nodeId || (declaredNodeIds && !declaredNodeIds.includes(nodeId))) return previous;
  if (event.type === "node.start")
    return transition(
      previous,
      "running",
      nodes([...previous.currentNodes, nodeId]),
      null,
      event.ts,
    );
  if (event.type === "node.end" || event.type === "node.skipped") {
    return transition(
      previous,
      previous.phase,
      previous.currentNodes.filter((id) => id !== nodeId),
      previous.waitingOn,
      event.ts,
    );
  }
  return previous;
}

/** Metadata keys are authored by the graph; values may refer only to public input/state/run data. */
export function resolveRunLabels(
  declared: Record<string, string> | undefined,
  input: Record<string, unknown>,
  threadId: string,
): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const [key, template] of Object.entries(declared ?? {}).slice(0, 32)) {
    if (!key || key.length > 128) continue;
    try {
      const value: unknown = renderDeep(template, { input, state: input, run: { threadId } });
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        entries.push([key, String(value).slice(0, 1024)]);
    } catch {
      /* Unavailable metadata must never stop execution. */
    }
  }
  return Object.fromEntries(entries);
}

export function parseRunActivity(value: unknown): RunActivity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<RunActivity>;
  if (
    !["ready", "running", "interrupted", "paused", "completed", "failed", "aborted"].includes(
      record.phase ?? "",
    ) ||
    !["you", "external", "both", "unknown", null].includes(record.waitingOn ?? null) ||
    typeof record.stateSince !== "string" ||
    !Number.isFinite(Date.parse(record.stateSince)) ||
    !Array.isArray(record.currentNodes)
  )
    return undefined;
  return {
    phase: record.phase!,
    currentNodes: nodes(record.currentNodes),
    waitingOn: record.waitingOn ?? null,
    stateSince: record.stateSince,
  };
}
