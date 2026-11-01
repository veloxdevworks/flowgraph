import { randomBytes } from "node:crypto";
import * as os from "node:os";
import { isSystemError } from "./errors.js";
import { log } from "./metrics.js";
import type { ServerEvent } from "./types.js";

/**
 * Run events reach clients over SSE, `/invocations` streams, connect and the
 * event journal. An error from a system call (file system, network) names
 * server paths or addresses, so an event carrying one gets a generic message
 * and an error id instead; the detail goes to the server log under the same
 * id. Errors from a graph's own nodes and logic keep their message.
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

/** Event types whose data can carry an error's text. */
const ERROR_EVENT_TYPES = new Set(["run.error", "run.aborted", "run.issue", "node.error", "hook.error", "skill.error"]);
/** The data fields of those events that hold it. */
const ERROR_FIELDS = ["message", "error", "reason"] as const;

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
 * `event` with system error text in its error fields replaced by
 * {@link internalErrorMessage}, plus `data.errorId`; the original text is
 * logged as `run.event.error` with that id. Other events are returned as is.
 */
export function redactEventErrors(threadId: string, event: ServerEvent): ServerEvent {
  if (!ERROR_EVENT_TYPES.has(event.type)) return event;
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return event;
  const fields = data as Record<string, unknown>;
  const leaked = ERROR_FIELDS.filter((f) => typeof fields[f] === "string" && isSystemErrorText(fields[f] as string));
  if (leaked.length === 0) return event;
  const errorId = newErrorId();
  const original: Record<string, unknown> = {};
  const replaced: Record<string, unknown> = { ...fields, errorId };
  for (const f of leaked) {
    original[f] = fields[f];
    replaced[f] = internalErrorMessage(errorId);
  }
  log("error", "run.event.error", {
    threadId,
    errorId,
    eventType: event.type,
    ...(typeof fields.nodeId === "string" ? { nodeId: fields.nodeId } : {}),
    ...original,
  });
  return { ...event, data: replaced };
}
