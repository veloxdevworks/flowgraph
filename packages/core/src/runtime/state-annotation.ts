/**
 * Build a LangGraph state Annotation from the graph spec's channels.
 * Adds a reserved `__once` channel for idempotency bookkeeping.
 */

import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { GraphSpec } from "@flowgraph/spec";
import { registry } from "../registry.js";
import { ISSUES_CHANNEL_CAP, issueDedupeKey, type RunIssue } from "./run-issues.js";

export const ONCE_CHANNEL = "__once";
/** Serialized agent replay dumps keyed by `threadId:nodeId`. */
export const REPLAY_CHANNEL = "__agentReplay";
/** Fan-in bag for checkpointed map workers: `{ [mapId]: Array<{ i, v }> }`. */
export const MAP_COLLECT_CHANNEL = "__mapCollect";
/** Per-Send map worker payload (index, item, binding name). */
export const MAP_TASK_CHANNEL = "__mapTask";
/** Persisted `service` start intents for rehydrate-on-resume. */
export const SERVICES_CHANNEL = "__services";
/** Paths of git worktrees created by `type: worktree` (cleanupOnEnd). */
export const WORKTREES_CHANNEL = "__worktrees";
/** Accumulated run issues (capped; full history is on disk). */
export const ISSUES_CHANNEL = "__issues";

export const RESERVED_STATE_CHANNELS = [
  ONCE_CHANNEL,
  REPLAY_CHANNEL,
  MAP_COLLECT_CHANNEL,
  MAP_TASK_CHANNEL,
  SERVICES_CHANNEL,
  WORKTREES_CHANNEL,
  ISSUES_CHANNEL,
] as const;

type ChannelDef = NonNullable<GraphSpec["state"]>["channels"][string];

export type ChannelReducerAndDefault = {
  reducer: (current: unknown, incoming: unknown) => unknown;
  default: () => unknown;
};

/** Resolve reducer/default for a channel — exported for unit tests. */
export function channelReducerAndDefault(
  channelName: string,
  ch: ChannelDef,
): ChannelReducerAndDefault {
  if (ch.reducer === "append" || ch.reducer === "concat") {
    return {
      reducer: (cur: unknown, inc: unknown) => {
        const current = (cur as unknown[] | undefined) ?? [];
        const incoming = Array.isArray(inc) ? inc : [inc];
        return [...current, ...incoming];
      },
      default: () => (ch.default as unknown[] | undefined) ?? [],
    };
  }

  if (ch.reducer === "merge" || ch.reducer === "mergeDeep") {
    return {
      reducer: (cur: unknown, inc: unknown) => {
        const current = (cur as Record<string, unknown> | undefined) ?? {};
        const incoming = inc as Record<string, unknown>;
        return ch.reducer === "mergeDeep"
          ? deepMerge(current, incoming)
          : { ...current, ...incoming };
      },
      default: () => (ch.default as Record<string, unknown> | undefined) ?? {},
    };
  }

  if (ch.type === "messages" || ch.reducer === "messages") {
    return {
      reducer: tolerantMessagesReducer,
      default: () => (ch.default as unknown[] | undefined) ?? [],
    };
  }

  if (ch.reducer?.startsWith("custom:")) {
    const reducerName = ch.reducer.slice("custom:".length);
    const fn = registry.getReducer(reducerName);
    if (!fn) {
      throw new Error(
        `Channel "${channelName}" uses reducer "custom:${reducerName}" but no reducer is registered under that name. ` +
          `Call registry.registerReducer("${reducerName}", fn) or add imports: [{ reducers: "..." }] before compiling this graph.`,
      );
    }
    return {
      reducer: (cur, inc) => fn(cur, inc),
      default: () => ch.default ?? null,
    };
  }

  return {
    reducer: (_cur: unknown, inc: unknown) => inc,
    default: () => ch.default ?? null,
  };
}

type Reducer = (current: unknown, incoming: unknown) => unknown;
const REMOVE_ALL_MESSAGES = "__remove_all__";
const baseMessagesReducer = messagesStateReducer as Reducer;

function isRemoval(m: unknown): m is { id?: unknown } {
  if (!m || typeof m !== "object") return false;
  const t = (m as { _getType?: () => string; getType?: () => string; type?: unknown });
  return (t._getType?.() ?? t.getType?.() ?? t.type) === "remove";
}

/**
 * messagesStateReducer, except that removing an id that is not (or no
 * longer) in the channel is a no-op instead of an error. Two writers can
 * compact the same history in one step (parallel branches, a subgraph and
 * its parent), and the second removal must not fail the run.
 */
function tolerantMessagesReducer(current: unknown, incoming: unknown): unknown {
  const inc = Array.isArray(incoming) ? incoming : [incoming];
  if (!inc.some(isRemoval)) return baseMessagesReducer(current, incoming);
  const known = new Set<unknown>();
  for (const m of (Array.isArray(current) ? current : current == null ? [] : [current]) as Array<{ id?: unknown }>) {
    if (m && typeof m === "object" && m.id !== undefined) known.add(m.id);
  }
  const kept: unknown[] = [];
  for (const m of inc) {
    if (isRemoval(m)) {
      if (m.id !== REMOVE_ALL_MESSAGES && !known.has(m.id)) continue;
      known.delete(m.id);
    } else if (m && typeof m === "object" && (m as { id?: unknown }).id !== undefined) {
      known.add((m as { id?: unknown }).id);
    }
    kept.push(m);
  }
  return baseMessagesReducer(current, kept);
}

export function buildStateAnnotation(spec: GraphSpec): ReturnType<typeof Annotation.Root> {
  const channels = spec.state?.channels ?? {};
  const fields: Record<string, unknown> = {};

  for (const [name, ch] of Object.entries(channels)) {
    const { reducer, default: defaultFn } = channelReducerAndDefault(name, ch);
    fields[name] = Annotation<unknown>({
      reducer,
      default: defaultFn,
    });
  }

  if (Object.keys(fields).length === 0) {
    fields["result"] = Annotation<unknown>({
      reducer: (_cur: unknown, inc: unknown) => inc,
      default: () => null,
    });
  }

  const mergeRecords = {
    reducer: (cur: Record<string, unknown> = {}, inc: Record<string, unknown>) => ({ ...cur, ...inc }),
    default: () => ({}),
  };

  // Reserved idempotency channel: merge of completed once-keys → results
  fields[ONCE_CHANNEL] = Annotation<Record<string, unknown>>(mergeRecords);
  fields[REPLAY_CHANNEL] = Annotation<Record<string, unknown>>({
    reducer: (cur: Record<string, unknown> = {}, inc: Record<string, unknown>) => {
      const out: Record<string, unknown> = { ...cur };
      for (const [k, v] of Object.entries(inc ?? {})) {
        if (v == null) delete out[k];
        else out[k] = v;
      }
      return out;
    },
    default: () => ({}),
  });
  fields[SERVICES_CHANNEL] = Annotation<Record<string, unknown>>({
    reducer: (cur: Record<string, unknown> = {}, inc: Record<string, unknown>) => {
      const out: Record<string, unknown> = { ...cur };
      for (const [k, v] of Object.entries(inc ?? {})) {
        if (v == null) delete out[k];
        else out[k] = v;
      }
      return out;
    },
    default: () => ({}),
  });
  fields[MAP_TASK_CHANNEL] = Annotation<unknown>({
    reducer: (_cur: unknown, inc: unknown) => inc,
    default: () => null,
  });
  fields[WORKTREES_CHANNEL] = Annotation<unknown[]>({
    reducer: (cur: unknown[] = [], inc: unknown) => {
      const incoming = Array.isArray(inc) ? inc : [inc];
      return [...cur, ...incoming];
    },
    default: () => [],
  });
  fields[ISSUES_CHANNEL] = Annotation<RunIssue[]>({
    reducer: (cur: RunIssue[] = [], inc: unknown) => {
      const incoming = (Array.isArray(inc) ? inc : [inc]) as RunIssue[];
      const out = [...cur];
      const seen = new Set(cur.map((i) => issueDedupeKey(i)));
      for (const issue of incoming) {
        if (!issue || typeof issue !== "object" || typeof issue.code !== "string") continue;
        const key = issueDedupeKey(issue);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(issue);
      }
      return out.length > ISSUES_CHANNEL_CAP ? out.slice(-ISSUES_CHANNEL_CAP) : out;
    },
    default: () => [],
  });
  fields[MAP_COLLECT_CHANNEL] = Annotation<Record<string, unknown>>({
    reducer: (cur: Record<string, unknown> = {}, inc: Record<string, unknown>) => {
      const out: Record<string, unknown> = { ...cur };
      for (const [k, v] of Object.entries(inc ?? {})) {
        const prev = Array.isArray(out[k]) ? (out[k] as unknown[]) : [];
        const add = Array.isArray(v) ? v : [v];
        out[k] = [...prev, ...add];
      }
      return out;
    },
    default: () => ({}),
  });

  return Annotation.Root(fields as Parameters<typeof Annotation.Root>[0]);
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const existing = out[k];
    if (
      existing != null &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      v != null &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
