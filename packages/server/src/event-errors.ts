import { createHmac, randomBytes } from "node:crypto";
import * as os from "node:os";
import { isSystemError } from "./errors.js";
import { log } from "./metrics.js";
import type { ServerEvent } from "./types.js";

/**
 * Run events reach clients over SSE, `/invocations` streams, connect and the
 * event journal. An error from a system call (file system, network) names
 * server paths or addresses, so where events, issues and state carry one it
 * is replaced by a generic message with an error id; the text goes to the
 * server log under the same id. Errors from a graph's own nodes and logic
 * keep their message.
 */

/**
 * Node's system error codes: the errno names (`EACCES`, `ENOSPC`, ...) and
 * the resolver's (`ENOTFOUND`, `EAI_AGAIN`, ...).
 */
const ERRNO_CODES = new Set(
  [...Object.keys(os.constants.errno), "ENOTFOUND", "ENODATA", "ESERVFAIL", "EREFUSED", "ECONNREFUSED", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME"].filter((c) =>
    /^E[A-Z0-9_]+$/.test(c),
  ),
);

/** Words that may be an errno code. Linear: a match starts only at a word boundary. */
const CODE_CANDIDATE = /\bE[A-Z0-9_]+\b/g;
/**
 * After a code, file-system text: `EACCES: permission denied, open '/x'`.
 * The description between `: ` and `, ` is short and has no comma.
 */
const AFTER_CODE = /^: [^,\n]{0,64}, [a-z]/;
const AFTER_CODE_SPAN = 2 + 64 + 3;
/** Before a code, network text: `connect ECONNREFUSED`, `getaddrinfo ENOTFOUND`. */
const BEFORE_CODE = /\b[a-z]\w{0,32} $/;
const BEFORE_CODE_SPAN = 1 + 32 + 1;

/**
 * Whether `text` holds Node's system error text, with the work it took:
 * each errno code found is checked against at most a fixed number of the
 * characters around it, so the check is linear in the length of `text`.
 * @internal Exported for tests.
 */
export function scanSystemErrorText(text: string): { found: boolean; codes: number; charsChecked: number } {
  let codes = 0;
  let charsChecked = 0;
  CODE_CANDIDATE.lastIndex = 0;
  for (let m = CODE_CANDIDATE.exec(text); m; m = CODE_CANDIDATE.exec(text)) {
    if (!ERRNO_CODES.has(m[0])) continue;
    codes++;
    const end = m.index + m[0].length;
    const after = text.slice(end, end + AFTER_CODE_SPAN);
    const before = text.slice(Math.max(0, m.index - BEFORE_CODE_SPAN), m.index);
    charsChecked += after.length + before.length;
    if (AFTER_CODE.test(after) || BEFORE_CODE.test(before)) {
      CODE_CANDIDATE.lastIndex = 0;
      return { found: true, codes, charsChecked };
    }
  }
  return { found: false, codes, charsChecked };
}

/** True when `text` holds a system error's message. */
export function isSystemErrorText(text: string): boolean {
  return scanSystemErrorText(text).found;
}

/** A fresh id that ties a client-facing message to its server log line. */
export function newErrorId(): string {
  return `err_${randomBytes(6).toString("hex")}`;
}

/** What a client sees in place of a system error. */
export function internalErrorMessage(errorId: string): string {
  return `Internal server error (error id ${errorId})`;
}

/**
 * The message for a run failure the server caught itself: the error's own
 * message, or for a system error {@link internalErrorMessage} with `errorId`
 * (the id the caller logged the error under).
 */
export function runErrorMessage(err: unknown, errorId: string): { message: string; redacted: boolean } {
  const message = err instanceof Error ? err.message : String(err);
  if (isSystemError(err) || isSystemErrorText(message)) return { message: internalErrorMessage(errorId), redacted: true };
  return { message, redacted: false };
}

/**
 * Event types that report a failure. Every string anywhere in their data is
 * checked: message, error, reason and nested detail alike.
 */
const ERROR_EVENT_TYPES = new Set(["run.error", "run.aborted", "run.issue", "node.error", "node.retry", "hook.error", "skill.error"]);
/** Event types that carry a node's state update or a run's state, issues included. */
const UPDATE_EVENT_TYPES = new Set(["node.end", "state.update", "run.end", "run.paused"]);
/** The engine's state channel holding a run's issues (`ISSUES_CHANNEL` in core). */
const ISSUES_KEY = "__issues";
/** How deep a payload is walked; past this, values are passed on as they are. */
const MAX_DEPTH = 12;
/** How many error ids a masker remembers having logged before it starts over. */
const MAX_LOGGED_IDS = 10_000;

type Masked<T> = { value: T; errorIds: string[] };

/**
 * Replaces system error text in what the server sends with
 * {@link internalErrorMessage} and an error id.
 *
 * The id is the first 12 hex characters of HMAC-SHA256 over the thread id
 * and the text, keyed by `key` (`FLOWGRAPH_ERROR_ID_KEY`) or, without one,
 * by 32 random bytes chosen when the masker is made. The same text in the
 * same thread gets the same id from every masker with the same key, a
 * different id in another thread, and an id nobody can recompute without the
 * key. Each masker logs an id with its full text (`run.event.error`) the
 * first time it hands it out.
 */
export class ErrorMasker {
  readonly #key: Buffer;
  readonly #logged = new Set<string>();

  constructor(key?: string) {
    this.#key = key ? Buffer.from(key, "utf8") : randomBytes(32);
  }

  /** The id for system error `text` seen in `threadId`. */
  errorId(threadId: string, text: string): string {
    return `err_${createHmac("sha256", this.#key).update(threadId).update("\0").update(text).digest("hex").slice(0, 12)}`;
  }

  /**
   * `value` with every string that holds system error text, at any depth,
   * masked; the ids used are returned, first seen first.
   */
  mask<T>(threadId: string, value: T, source: string): Masked<T> {
    const errorIds: string[] = [];
    const walk = (v: unknown, depth: number): unknown => {
      if (typeof v === "string") {
        if (!isSystemErrorText(v)) return v;
        const errorId = this.errorId(threadId, v);
        if (!errorIds.includes(errorId)) errorIds.push(errorId);
        if (!this.#logged.has(errorId)) {
          if (this.#logged.size >= MAX_LOGGED_IDS) this.#logged.clear();
          this.#logged.add(errorId);
          log("error", "run.event.error", { threadId, errorId, source, text: v });
        }
        return internalErrorMessage(errorId);
      }
      return mapChildren(v, depth, (item) => walk(item, depth + 1));
    };
    return { value: walk(value, 0) as T, errorIds };
  }

  /**
   * `value` with the run issues it holds under `__issues` keys, at any depth
   * (a state snapshot, a state history, a node's update), masked by
   * {@link mask}. Nothing else in it is changed.
   */
  maskIssues<T>(threadId: string, value: T, source: string): Masked<T> {
    const errorIds: string[] = [];
    const walk = (v: unknown, depth: number): unknown =>
      mapChildren(v, depth, (item, key) => {
        if (key !== ISSUES_KEY) return walk(item, depth + 1);
        const m = this.mask(threadId, item, source);
        for (const id of m.errorIds) if (!errorIds.includes(id)) errorIds.push(id);
        return m.value;
      });
    return { value: walk(value, 0) as T, errorIds };
  }

  /**
   * `event` with system error text masked where events carry it: anywhere in
   * the data of a failure event ({@link ERROR_EVENT_TYPES}), in the issues of a
   * node's update or a run's state (`node.end`, `state.update`, `run.end`,
   * `run.paused`), and in the per-block errors of `memory.recall`. A masked
   * event gets `data.errorId` (its first id). Other events, and events with
   * nothing to mask, are returned as they are.
   */
  redactEvent(threadId: string, event: ServerEvent): ServerEvent {
    const data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return event;
    const source = `event ${event.type}`;
    let masked: Masked<unknown>;
    if (ERROR_EVENT_TYPES.has(event.type)) {
      masked = this.mask(threadId, data, source);
    } else if (event.type === "memory.recall") {
      const blocks = (data as Record<string, unknown>)["blocks"];
      const m = this.mask(threadId, blocks, source);
      masked = { value: m.value === blocks ? data : { ...data, blocks: m.value }, errorIds: m.errorIds };
    } else if (UPDATE_EVENT_TYPES.has(event.type)) {
      masked = this.maskIssues(threadId, data, source);
    } else {
      return event;
    }
    if (masked.value === data) return event;
    return { ...event, data: { ...(masked.value as Record<string, unknown>), ...(masked.errorIds[0] ? { errorId: masked.errorIds[0] } : {}) } };
  }
}

/** `v` with `fn` applied to each array item or object value; the same `v` when nothing changed. */
function mapChildren(v: unknown, depth: number, fn: (item: unknown, key: string | undefined) => unknown): unknown {
  if (depth >= MAX_DEPTH || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((item) => {
      const next = fn(item, undefined);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : v;
  }
  let out: Record<string, unknown> | undefined;
  for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
    const next = fn(item, k);
    if (next !== item) (out ??= { ...(v as Record<string, unknown>) })[k] = next;
  }
  return out ?? v;
}
