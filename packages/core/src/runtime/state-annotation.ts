/**
 * Build a LangGraph state Annotation from the graph spec's channels.
 * Adds a reserved `__once` channel for idempotency bookkeeping.
 */

import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { GraphSpec } from "@flowgraph/spec";
import { registry } from "../registry.js";
import { ISSUES_CHANNEL_CAP, issueDedupeKey, type RunIssue } from "./run-issues.js";

export const ONCE_CHANNEL = "__once";
/** Declared so checkpoints written by older versions still load; the engine no longer reads or writes it. */
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
      reducer: messagesStateReducer as (current: unknown, incoming: unknown) => unknown,
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
  // Unused, kept on purpose: threads checkpointed by earlier releases carry
  // values (and pending writes) for this channel, and keeping it declared
  // means those checkpoints restore into the same channel set. Nothing reads
  // or writes it; agent replay entries come from the snapshot the engine
  // attaches to interrupts (providers/replay-cache.ts).
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
