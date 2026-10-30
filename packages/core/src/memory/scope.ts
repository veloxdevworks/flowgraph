/**
 * Scope tuple construction and validation.
 */
import { createHash } from "node:crypto";
import { MemoryError, type MemoryScopeName, type MemoryTuple, MEMORY_SCOPES } from "./types.js";

export interface MemoryBinding {
  org: string;
  project: string;
  /** Root graph name (subgraphs inherit it). */
  graph: string;
  /** Empty string when no user is known. */
  user: string;
  subject?: { type: string; key: string } | undefined;
}

export const EMPTY_TUPLE: MemoryTuple = { org: "", project: "", graph: "", usr: "", subjectType: "", subjectKey: "" };

export function isMemoryScopeName(s: unknown): s is MemoryScopeName {
  return typeof s === "string" && (MEMORY_SCOPES as readonly string[]).includes(s);
}

/**
 * Build the tuple for a scope from a pre-bound binding. Throws
 * MEMORY_SCOPE_UNAVAILABLE when the binding lacks the level (no user / no subject).
 */
export function tupleForScope(binding: MemoryBinding, scope: MemoryScopeName): MemoryTuple {
  const base = { ...EMPTY_TUPLE, org: binding.org };
  switch (scope) {
    case "org":
      return base;
    case "project":
      return { ...base, project: binding.project };
    case "graph":
      return { ...base, project: binding.project, graph: binding.graph };
    case "user":
      if (!binding.user) {
        throw new MemoryError(
          "MEMORY_SCOPE_UNAVAILABLE",
          "user scope is unavailable: this run has no user identity (set FLOWGRAPH_USER or git config user.email)",
        );
      }
      return { ...base, project: binding.project, graph: binding.graph, usr: binding.user };
    case "subject":
      if (!binding.subject) {
        throw new MemoryError(
          "MEMORY_SCOPE_UNAVAILABLE",
          "subject scope is unavailable: runtime.memory.subject is not declared or did not resolve for this run",
        );
      }
      return { ...base, project: binding.project, subjectType: binding.subject.type, subjectKey: binding.subject.key };
    default:
      throw new MemoryError("MEMORY_SCOPE_INVALID", `unknown scope "${String(scope)}"`);
  }
}

/** Scopes that are actually available for this binding, in read precedence order. */
export function availableScopes(binding: MemoryBinding, order: readonly MemoryScopeName[]): MemoryScopeName[] {
  return order.filter((s) => (s === "user" ? !!binding.user : s === "subject" ? !!binding.subject : true));
}

/** Validate that a tuple has one of the five legal shapes; return its scope name. */
export function scopeOfTuple(t: MemoryTuple): MemoryScopeName {
  if (!t.org) throw new MemoryError("MEMORY_SCOPE_INVALID", "org must be non-empty");
  if ((t.subjectType === "") !== (t.subjectKey === "")) {
    throw new MemoryError("MEMORY_SCOPE_INVALID", "subject type and key must both be set or both be empty");
  }
  if (t.subjectType !== "") {
    if (t.graph !== "" || t.usr !== "" || t.project === "") {
      throw new MemoryError("MEMORY_SCOPE_INVALID", "subject scope requires a project and no graph/user");
    }
    return "subject";
  }
  if (t.usr !== "") {
    if (t.graph === "") throw new MemoryError("MEMORY_SCOPE_INVALID", "user scope requires a graph");
    if (t.project === "") throw new MemoryError("MEMORY_SCOPE_INVALID", "user scope requires a project");
    return "user";
  }
  if (t.graph !== "") {
    if (t.project === "") throw new MemoryError("MEMORY_SCOPE_INVALID", "graph scope requires a project");
    return "graph";
  }
  return t.project !== "" ? "project" : "org";
}

export function tupleKey(t: MemoryTuple): string {
  return [t.org, t.project, t.graph, t.usr, t.subjectType, t.subjectKey].join("\u0000");
}

const SUBJECT_KEY_RE = /^[A-Za-z0-9._:/@-]+$/;
export const SUBJECT_TYPE_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Normalize a rendered subject key: trim, optional sha256, ≤128 chars of
 * `[A-Za-z0-9._:/@-]`. Returns undefined for empty/nullish input.
 */
export function normalizeSubjectKey(raw: unknown, opts: { hash?: boolean } = {}): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new MemoryError("MEMORY_SUBJECT_UNRESOLVED", `subject key must render to a string, got ${typeof raw}`);
  }
  const s = String(raw).trim();
  if (s === "" || s === "null" || s === "undefined") return undefined;
  if (opts.hash) return `sha256:${createHash("sha256").update(s).digest("hex")}`;
  if (s.toLowerCase().startsWith("sha256:")) {
    throw new MemoryError(
      "MEMORY_SUBJECT_UNRESOLVED",
      `subject key "${s.slice(0, 40)}…" uses the reserved "sha256:" prefix (hashed keys); remove it or use hash: true`,
    );
  }
  if (s.length > 128) {
    throw new MemoryError("MEMORY_SUBJECT_UNRESOLVED", `subject key is longer than 128 characters (use hash: true)`);
  }
  if (!SUBJECT_KEY_RE.test(s)) {
    throw new MemoryError(
      "MEMORY_SUBJECT_UNRESOLVED",
      `subject key "${s}" has characters outside [A-Za-z0-9._:/@-] (use hash: true)`,
    );
  }
  return s;
}
