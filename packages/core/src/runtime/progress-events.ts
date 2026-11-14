import { isDeepStrictEqual } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import type { EventBus, StateUpdateData } from "../events.js";
import { isReservedChannel } from "../node-policy.js";

interface ProgressObservation {
  previous?: Record<string, unknown>;
}
const observation = new AsyncLocalStorage<ProgressObservation>();

/** @internal Capture actual defaulted/input state even when input wrote no public channel. */
export function captureProgressBaseline(state: Record<string, unknown>): void {
  const current = observation.getStore();
  if (current && !current.previous) current.previous = snapshot(state);
}

function snapshot(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([key]) => !isReservedChannel(key))
      .map(([key, value]) => {
        // State is normally JSON data. Keep an opaque, non-cloneable custom value
        // observable without letting an observation failure stop graph execution.
        try {
          return [key, structuredClone(value)];
        } catch {
          return [key, value];
        }
      }),
  );
}

function eventSnapshot(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      // Match state APIs / JSONL exactly, including LangChain messages, Buffer,
      // and other toJSON-bearing values. structuredClone alone loses toJSON.
      try {
        const json = JSON.stringify(value);
        return [key, json === undefined ? undefined : JSON.parse(json)];
      } catch {
        return [key, snapshot({ value }).value];
      }
    }),
  );
}

/**
 * Consume LangGraph's committed `values` stream with the same final-value /
 * interrupt aggregation as invoke(). The initial snapshot is the baseline;
 * subsequent values contain the actual channel reducers' results, not node
 * write proposals (which can still be retried, transformed, or rejected).
 */
export async function invokeWithProgress(
  openStream: () => Promise<AsyncIterable<Record<string, unknown>>>,
  events: EventBus,
  baseline?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return observation.run(baseline ? { previous: snapshot(baseline) } : {}, async () => {
    const currentObservation = observation.getStore()!;
    let latest: Record<string, unknown> = {};
    const interrupts: unknown[] = [];
    let skipInitial = baseline !== undefined;
    for await (const chunk of await openStream()) {
      if ("__interrupt__" in chunk) {
        if (Array.isArray(chunk["__interrupt__"])) interrupts.push(...chunk["__interrupt__"]);
        continue;
      }
      latest = chunk;
      // A resumed stream initially exposes the checkpoint before it overlays
      // completed siblings' pending writes. They are already in getState()'s
      // baseline and must not be reported as a rollback followed by a repeat.
      if (skipInitial) {
        skipInitial = false;
        continue;
      }
      const current = snapshot(chunk);
      const previous = currentObservation.previous;
      const channels = previous
        ? Object.keys(current).filter((key) => !isDeepStrictEqual(previous[key], current[key]))
        : [];
      currentObservation.previous = current;
      if (channels.length > 0) {
        const data: StateUpdateData = {
          channels,
          update: eventSnapshot(Object.fromEntries(channels.map((key) => [key, chunk[key]]))),
        };
        // JSON-compatible state reaches sinks as a detached canonical copy,
        // preserving wire serialization, comparison baseline, and live state.
        events.emit("state.update", data);
      }
    }
    return interrupts.length > 0 ? { ...latest, __interrupt__: interrupts } : latest;
  });
}
