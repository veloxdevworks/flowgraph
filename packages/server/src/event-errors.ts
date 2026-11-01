import { createHash, randomBytes } from "node:crypto";
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
const ERRNO_CODES = [...Object.keys(os.constants.errno), "ENOTFOUND", "ENODATA", "ESERVFAIL", "EREFUSED", "ECONNREFUSED", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME"]
  .filter((c, i, all) => /^E[A-Z0-9_]+$/.test(c) && all.indexOf(c) === i)
  .join("|");

/**
 * Node's system error text: `EACCES: permission denied, open '/x'` (file
 * system) and `connect ECONNREFUSED 127.0.0.1:5432` (network). The engine
 * passes node errors on as text, so this is how they are recognised.
 */
const SYSTEM_ERROR_TEXT = new RegExp(`\\b(?:${ERRNO_CODES}): [^,\\n]*, [a-z]\\w*|\\b[a-z]\\w* (?:${ERRNO_CODES})\\b`);

/**
 * Event types that report a failure. Every string anywhere in their data is
 * checked: message, error, reason and nested detail alike.
 */
const ERROR_EVENT_TYPES = new Set(["run.error", "run.aborted", "run.issue", "node.error", "node.retry", "hook.error", "skill.error"]);
/** Event types that carry a node's state update, issues included. */
const UPDATE_EVENT_TYPES = new Set(["node.end", "state.update", "run.end", "run.paused"]);
/** The engine's state channel holding a run's issues (`ISSUES_CHANNEL` in core). */
const ISSUES_KEY = "__issues";
/** How deep a payload is walked; past this, values are passed on as they are. */
const MAX_DEPTH = 12;

/** True when `text` holds a system error's message. */
export function isSystemErrorText(text: string): boolean {
  return SYSTEM_ERROR_TEXT.test(text);
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
 * The id for system error `text` seen in `threadId`. The same text gets the
 * same id wherever it appears (an event, the issues list, the state), so a
 * client can match all of them to one log line.
 */
function textErrorId(threadId: string, text: string): string {
  return `err_${createHash("sha256").update(threadId).update("\0").update(text).digest("hex").slice(0, 12)}`;
}

/** Error ids already logged by this process, so a text read again is not logged again. */
const loggedIds = new Set<string>();
const MAX_LOGGED_IDS = 10_000;

/**
 * `value` with every string that holds system error text, at any depth,
 * replaced by {@link internalErrorMessage}. Each replaced text is logged once
 * per process as `run.event.error` with its id, the thread and `source`.
 * Returns the ids used, first seen first.
 */
export function maskSystemErrorText<T>(threadId: string, value: T, source: string): { value: T; errorIds: string[] } {
  const errorIds: string[] = [];
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      if (!isSystemErrorText(v)) return v;
      const errorId = textErrorId(threadId, v);
      if (!errorIds.includes(errorId)) errorIds.push(errorId);
      if (!loggedIds.has(errorId)) {
        if (loggedIds.size >= MAX_LOGGED_IDS) loggedIds.clear();
        loggedIds.add(errorId);
        log("error", "run.event.error", { threadId, errorId, source, text: v });
      }
      return internalErrorMessage(errorId);
    }
    if (depth >= MAX_DEPTH || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((item) => {
        const next = walk(item, depth + 1);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : v;
    }
    let out: Record<string, unknown> | undefined;
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      const next = walk(item, depth + 1);
      if (next !== item) (out ??= { ...(v as Record<string, unknown>) })[k] = next;
    }
    return out ?? v;
  };
  return { value: walk(value, 0) as T, errorIds };
}

/**
 * `value` with the run issues it holds under `__issues` keys, at any depth
 * (a state snapshot, a state history, a node's update), masked by
 * {@link maskSystemErrorText}. Nothing else in it is changed.
 */
export function maskIssuesIn<T>(threadId: string, value: T, source: string): { value: T; errorIds: string[] } {
  const errorIds: string[] = [];
  const walk = (v: unknown, depth: number): unknown => {
    if (depth >= MAX_DEPTH || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((item) => {
        const next = walk(item, depth + 1);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : v;
    }
    let out: Record<string, unknown> | undefined;
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      let next: unknown;
      if (k === ISSUES_KEY) {
        const m = maskSystemErrorText(threadId, item, source);
        for (const id of m.errorIds) if (!errorIds.includes(id)) errorIds.push(id);
        next = m.value;
      } else {
        next = walk(item, depth + 1);
      }
      if (next !== item) (out ??= { ...(v as Record<string, unknown>) })[k] = next;
    }
    return out ?? v;
  };
  return { value: walk(value, 0) as T, errorIds };
}

/**
 * `event` with system error text masked where events carry it: anywhere in
 * the data of a failure event ({@link ERROR_EVENT_TYPES}), in the issues of a
 * node's update or a run's state (`node.end`, `state.update`, `run.end`,
 * `run.paused`), and in the per-block errors of
 * `memory.recall`. A masked event gets `data.errorId` (its first id). Other
 * events, and events with nothing to mask, are returned as they are.
 */
export function redactEventErrors(threadId: string, event: ServerEvent): ServerEvent {
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return event;
  const source = `event ${event.type}`;
  let masked: { value: unknown; errorIds: string[] };
  if (ERROR_EVENT_TYPES.has(event.type)) {
    masked = maskSystemErrorText(threadId, data, source);
  } else if (event.type === "memory.recall") {
    const blocks = (data as Record<string, unknown>)["blocks"];
    const m = maskSystemErrorText(threadId, blocks, source);
    masked = { value: m.value === blocks ? data : { ...data, blocks: m.value }, errorIds: m.errorIds };
  } else if (UPDATE_EVENT_TYPES.has(event.type)) {
    masked = maskIssuesIn(threadId, data, source);
  } else {
    return event;
  }
  if (masked.value === data) return event;
  return { ...event, data: { ...(masked.value as Record<string, unknown>), ...(masked.errorIds[0] ? { errorId: masked.errorIds[0] } : {}) } };
}
