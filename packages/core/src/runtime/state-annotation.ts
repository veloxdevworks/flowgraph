/**
 * Build a LangGraph state Annotation from the graph spec's channels.
 * Adds a reserved `__once` channel for idempotency bookkeeping.
 */

import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { GraphSpec } from "@veloxdevworks/flowgraph-spec";
import { registry } from "../registry.js";

export const ONCE_CHANNEL = "__once";

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

  // Reserved idempotency channel: merge of completed once-keys → results
  fields[ONCE_CHANNEL] = Annotation<Record<string, unknown>>({
    reducer: (cur: Record<string, unknown> = {}, inc: Record<string, unknown>) => ({ ...cur, ...inc }),
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
