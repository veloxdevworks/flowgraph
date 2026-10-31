/**
 * Context artefacts (running summaries, and anything else the context code
 * derives from a fit) cached in the run's replay store, so a resumed agent
 * does not pay for them twice.
 *
 * An entry is found by kind and position, but it is only reused when it was
 * made from the same inputs: each entry carries a hash of everything that
 * produced it. A resume whose fit differs (a new budget, estimator, summary
 * settings, prompt, tools or history) gets a different hash and recomputes.
 * Context artefacts have no side effects, so recomputing is always safe, and
 * reusing an artefact made from other inputs never is.
 */
import { toolArgsHash, type ReplayStore } from "../providers/replay-cache.js";

/** Entry name of a context artefact: `ctx:<kind>:<index>`. */
export function contextEntryName(kind: string, index: number): string {
  return `ctx:${kind}:${index}`;
}

/** Hash of an artefact's inputs (stable JSON, key order independent). */
export function contextInputHash(inputs: unknown): string {
  return toolArgsHash(inputs);
}

interface ContextEntry {
  inputHash: string;
  value: unknown;
}

function isContextEntry(v: unknown): v is ContextEntry {
  return !!v && typeof v === "object" && typeof (v as ContextEntry).inputHash === "string" && "value" in (v as object);
}

/**
 * The cached artefact for `inputs`, or a newly computed one (stored for the
 * next resume). An entry made from other inputs, or in an older format, is
 * replaced.
 */
export async function cachedContextArtefact<T>(
  store: ReplayStore,
  cacheKey: string,
  kind: string,
  index: number,
  inputs: unknown,
  isValue: (v: unknown) => v is T,
  compute: () => Promise<T>,
): Promise<T> {
  const name = contextEntryName(kind, index);
  const inputHash = contextInputHash(inputs);
  const cached = store.get(cacheKey, name);
  if (isContextEntry(cached) && cached.inputHash === inputHash && isValue(cached.value)) return cached.value;
  const value = await compute();
  store.set(cacheKey, name, { inputHash, value } satisfies ContextEntry);
  return value;
}
