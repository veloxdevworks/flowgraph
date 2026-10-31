/**
 * Merge a subgraph's finished state back into its parent.
 *
 * `stateMap.out` is explicit: each key is a parent channel, each value is a
 * child channel or a `{{ }}` expression over the child state. With no
 * `stateMap.out`, channels that share a name are merged.
 *
 * The value handed to the parent is a reducer input. A delta (append suffix,
 * merge diff, message edits) is sent only when this parent channel is the one
 * that seeded the child value. Copying that same value onto a different
 * parent channel passes it through whole.
 */

import { RemoveMessage } from "@langchain/core/messages";
import { parseExpr, type Expr } from "@flowgraph/expr";
import { OUTPUTS_CHANNEL } from "../runtime/apply-output.js";
import { RESERVED_STATE_CHANNELS } from "../runtime/state-annotation.js";

export interface ChannelMergeDef {
  type?: string | undefined;
  reducer?: string | undefined;
}

const SKIP_MERGE = new Set<string>([OUTPUTS_CHANNEL, ...RESERVED_STATE_CHANNELS]);

export function isSkippedMergeChannel(name: string): boolean {
  return SKIP_MERGE.has(name);
}

/** `stateMap.out` entries: parent channel → child channel or expression. */
export function stateMapOutEntries(withBlock: unknown): Record<string, string> | undefined {
  if (withBlock == null || typeof withBlock !== "object" || Array.isArray(withBlock)) return undefined;
  const stateMap = (withBlock as { stateMap?: unknown }).stateMap;
  if (stateMap == null || typeof stateMap !== "object" || Array.isArray(stateMap)) return undefined;
  const out = (stateMap as { out?: unknown }).out;
  if (out == null || typeof out !== "object" || Array.isArray(out)) return undefined;
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(out as Record<string, unknown>)) {
    if (!key.trim() || typeof value !== "string") continue;
    entries[key.trim()] = value;
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

/**
 * Child channels named by a `stateMap.out` value.
 * A bare name is that channel. `{{ state.x }}` / `{{ result.x }}` name `x`.
 */
export function childChannelRefsInMapping(ref: string): string[] {
  const trimmed = ref.trim();
  if (!trimmed) return [];
  if (!trimmed.includes("{{")) return [trimmed];
  const names = new Set<string>();
  const re = /\{\{(.*?)\}\}/gs;
  let match: RegExpExecArray | null;
  while ((match = re.exec(trimmed)) !== null) {
    try {
      collectStateRoots(parseExpr(match[1]!.trim()), names);
    } catch {
      // Unparseable expressions are reported by the config schema, not here.
    }
  }
  return [...names];
}

/**
 * When the mapping is the whole child channel (`log` or `{{ state.log }}`),
 * the parent reducer should see a delta against the value we seeded.
 */
export function outputSourceChannel(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  if (!trimmed.includes("{{")) return trimmed;
  const match = trimmed.match(/^\{\{\s*(?:state|result)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/);
  return match?.[1];
}

function collectStateRoots(node: Expr, out: Set<string>): void {
  if (node.kind === "Member") {
    if (
      node.object.kind === "Ident" &&
      (node.object.name === "state" || node.object.name === "result")
    ) {
      out.add(node.property);
    }
    collectStateRoots(node.object, out);
    return;
  }
  if (node.kind === "Index") {
    collectStateRoots(node.object, out);
    collectStateRoots(node.index, out);
    return;
  }
  if (node.kind === "Call") {
    for (const arg of node.args) collectStateRoots(arg, out);
    return;
  }
  if (node.kind === "Unary") {
    collectStateRoots(node.operand, out);
    return;
  }
  if (node.kind === "Binary" || node.kind === "Nullish") {
    collectStateRoots(node.left, out);
    collectStateRoots(node.right, out);
    return;
  }
  if (node.kind === "Ternary") {
    collectStateRoots(node.condition, out);
    collectStateRoots(node.consequent, out);
    collectStateRoots(node.alternate, out);
    return;
  }
  if (node.kind === "Pipe") {
    collectStateRoots(node.left, out);
    for (const arg of node.args) collectStateRoots(arg, out);
    return;
  }
  if (node.kind === "Array") {
    for (const el of node.elements) collectStateRoots(el, out);
    return;
  }
  if (node.kind === "Object") {
    for (const entry of node.entries) collectStateRoots(entry.value, out);
  }
}

/** A value copied into a child channel, and which parent channel it came from. */
export interface ChannelSeed {
  value: unknown;
  /**
   * Set when `value` is a whole copy of this parent channel (`log` or
   * `{{ state.log }}`). Absent for computed expressions and node `input`.
   */
  fromParent?: string;
}

export function projectSubgraphInput(opts: {
  stateMapIn: Record<string, string> | undefined;
  parentState: Record<string, unknown>;
  nodeInput: Record<string, unknown>;
  childChannels: readonly string[];
  resolve: (ref: string) => unknown;
}): { input: Record<string, unknown>; seeds: Record<string, ChannelSeed> } {
  const input: Record<string, unknown> = {};
  const seeds: Record<string, ChannelSeed> = {};

  if (opts.stateMapIn) {
    for (const [childChannel, parentExpr] of Object.entries(opts.stateMapIn)) {
      const value = opts.resolve(parentExpr);
      input[childChannel] = value;
      const fromParent = typeof parentExpr === "string" ? outputSourceChannel(parentExpr) : undefined;
      seeds[childChannel] = fromParent ? { value, fromParent } : { value };
    }
  } else {
    const parentKeys = new Set(Object.keys(opts.parentState));
    for (const channel of opts.childChannels) {
      if (isSkippedMergeChannel(channel)) continue;
      if (!parentKeys.has(channel)) continue;
      const value = opts.parentState[channel];
      input[channel] = value;
      seeds[channel] = { value, fromParent: channel };
    }
  }

  for (const [key, value] of Object.entries(opts.nodeInput)) {
    input[key] = value;
    const prev = seeds[key];
    if (prev && deepEqual(prev.value, value)) continue;
    seeds[key] = { value };
  }

  return { input, seeds };
}

export function projectExplicitOutput(opts: {
  out: Record<string, string>;
  childState: Record<string, unknown>;
  seeds: Record<string, ChannelSeed>;
  parentChannels: Record<string, ChannelMergeDef>;
  /** Child channel definitions, including auto-declared `{ type: "any" }` targets. */
  childChannelDefs: Record<string, ChannelMergeDef>;
  resolve: (ref: string) => unknown;
}): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  for (const [parentChannel, childExpr] of Object.entries(opts.out)) {
    const source = outputSourceChannel(childExpr);
    const seed = source != null ? opts.seeds[source] : undefined;
    // Delta only when this parent channel is the one that seeded the child
    // value. `in: { draft: input }, out: { result: draft }` must still write
    // `result` when the child leaves `draft` unchanged.
    const sameChannel = seed?.fromParent != null && seed.fromParent === parentChannel;
    const value = opts.resolve(childExpr);
    const projected = reducerInput(
      opts.parentChannels[parentChannel],
      sameChannel,
      sameChannel ? seed!.value : undefined,
      value,
      childChannelUsesMessages(source != null ? opts.childChannelDefs[source] : undefined),
    );
    if (projected.omit) continue;
    update[parentChannel] = projected.value;
  }
  return update;
}

export function projectMatchingOutput(opts: {
  childState: Record<string, unknown>;
  seeds: Record<string, ChannelSeed>;
  parentChannels: Record<string, ChannelMergeDef>;
  childChannelDefs: Record<string, ChannelMergeDef>;
}): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  const parentNames = new Set(Object.keys(opts.parentChannels));

  for (const [channel, value] of Object.entries(opts.childState)) {
    if (isSkippedMergeChannel(channel)) continue;
    const seed = opts.seeds[channel];
    const seeded = seed != null;
    if (parentNames.has(channel)) {
      const sameChannel = seed?.fromParent === channel;
      const projected = reducerInput(
        opts.parentChannels[channel],
        sameChannel,
        sameChannel ? seed!.value : undefined,
        value,
        childChannelUsesMessages(opts.childChannelDefs[channel]),
      );
      if (projected.omit) continue;
      update[channel] = projected.value;
      continue;
    }
    // Not a parent channel. Still return it so a subgraph inside `map` can
    // be unwrapped as the item result. LangGraph drops it on a top-level node.
    if (seeded) {
      if (deepEqual(seed!.value, value)) continue;
      update[channel] = value;
      continue;
    }
    if (value === undefined || value === null) continue;
    update[channel] = value;
  }

  return update;
}

export function childChannelUsesMessages(def: ChannelMergeDef | undefined): boolean {
  return def?.type === "messages" || def?.reducer === "messages";
}

export function reducerInput(
  channel: ChannelMergeDef | undefined,
  seeded: boolean,
  seed: unknown,
  next: unknown,
  /**
   * When the child channel itself uses the messages reducer, an id present in
   * the seed and missing from the child state was removed inside the child.
   * A replace (`array`) or undeclared channel that returns only its reply did
   * not; those missing ids stay on the parent.
   */
  inferMessageRemovals = false,
): { omit: true } | { omit: false; value: unknown } {
  if (!seeded) return { omit: false, value: next };
  if (deepEqual(seed, next)) return { omit: true };

  const reducer = channel?.reducer;
  const type = channel?.type;

  if (reducer === "append" || reducer === "concat") {
    if (Array.isArray(seed) && Array.isArray(next)) {
      const extra = appendExtra(seed, next);
      if (extra.length === 0) return { omit: true };
      return { omit: false, value: extra };
    }
    return { omit: false, value: next };
  }

  if ((reducer === "merge" || reducer === "mergeDeep") && isPlainObject(seed) && isPlainObject(next)) {
    const diff = reducer === "mergeDeep" ? deepDiff(seed, next) : shallowDiff(seed, next);
    if (diff == null) return { omit: true };
    return { omit: false, value: diff };
  }

  if (reducer === "messages" || type === "messages") {
    const delta = messageDelta(seed, next, inferMessageRemovals);
    if (Array.isArray(delta) && delta.length === 0) return { omit: true };
    return { omit: false, value: delta };
  }

  return { omit: false, value: next };
}

/**
 * Items in `next` that are not already in `seed`.
 * A longer list that starts with `seed` contributes its suffix.
 * A shorter or overlapping list contributes only values the seed does not
 * already contain, so a truncated `[b]` is not appended onto `[a, b]`.
 * `append` cannot delete: dropped items stay on the parent.
 */
function appendExtra(seed: unknown[], next: unknown[]): unknown[] {
  if (arrayStartsWith(seed, next)) return next.slice(seed.length);
  const pool = [...seed];
  const extra: unknown[] = [];
  for (const item of next) {
    const idx = pool.findIndex((candidate) => deepEqual(candidate, item));
    if (idx >= 0) pool.splice(idx, 1);
    else extra.push(item);
  }
  return extra;
}

function messageDelta(seed: unknown, next: unknown, inferRemovals: boolean): unknown {
  if (!Array.isArray(seed) || !Array.isArray(next)) return next;
  const seedById = new Map<string, unknown>();
  for (const message of seed) {
    const id = messageId(message);
    if (id) seedById.set(id, message);
  }
  if (seedById.size === 0) return next;

  const seen = new Set<string>();
  const delta: unknown[] = [];
  for (const message of next) {
    const id = messageId(message);
    if (id == null) {
      delta.push(message);
      continue;
    }
    seen.add(id);
    if (isRemoveMessage(message)) {
      delta.push(message);
      continue;
    }
    if (!seedById.has(id) || !deepEqual(seedById.get(id), message)) delta.push(message);
  }
  if (inferRemovals) {
    for (const id of seedById.keys()) {
      if (!seen.has(id)) delta.push(new RemoveMessage({ id }));
    }
  }
  return delta;
}

function isRemoveMessage(message: unknown): boolean {
  if (RemoveMessage.isInstance(message)) return true;
  if (message == null || typeof message !== "object") return false;
  const rec = message as { type?: unknown; id?: unknown };
  return rec.type === "remove" && typeof rec.id === "string" && rec.id.length > 0;
}

function messageId(message: unknown): string | undefined {
  if (message == null || typeof message !== "object") return undefined;
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function shallowDiff(seed: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> | null {
  const diff: Record<string, unknown> = {};
  let any = false;
  for (const [key, value] of Object.entries(next)) {
    if (Object.prototype.hasOwnProperty.call(seed, key) && deepEqual(seed[key], value)) continue;
    diff[key] = value;
    any = true;
  }
  return any ? diff : null;
}

function deepDiff(seed: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> | null {
  const diff: Record<string, unknown> = {};
  let any = false;
  for (const [key, value] of Object.entries(next)) {
    if (!Object.prototype.hasOwnProperty.call(seed, key)) {
      diff[key] = value;
      any = true;
      continue;
    }
    const prev = seed[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      const child = deepDiff(prev, value);
      if (child) {
        diff[key] = child;
        any = true;
      }
      continue;
    }
    if (!deepEqual(prev, value)) {
      diff[key] = value;
      any = true;
    }
  }
  return any ? diff : null;
}

function arrayStartsWith(prefix: unknown[], value: unknown[]): boolean {
  if (prefix.length > value.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (!deepEqual(prefix[i], value[i])) return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
      if (!deepEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }
  return false;
}
