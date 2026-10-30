/**
 * Offline diagnostics for runtime.memory / runtime.store / memory nodes.
 */
import type { GraphSpec, Diagnostic } from "@flowgraph/spec";
import { walkNodes } from "../discover-skills.js";
import { MEMORY_HARD_CAPS } from "./types.js";

const WRITE_OPS = new Set(["put", "patch", "increment", "append", "delete"]);

function durableCheckpoint(spec: GraphSpec): string | undefined {
  const ck = spec.runtime?.checkpoint;
  if (!ck || ck.enabled === false) return undefined;
  const b = ck.backend ?? "memory";
  return b === "sqlite" || b === "postgres" ? b : undefined;
}

/** Host-independent memory diagnostics (part of `validateSpec`). */
export function memoryLintDiagnostics(spec: GraphSpec): Diagnostic[] {
  const out: Diagnostic[] = [];
  const mem = spec.runtime?.memory;
  const store = spec.runtime?.store;

  if (mem && store) {
    out.push({
      severity: "error",
      code: "MEMORY_STORE_AND_MEMORY",
      message: "runtime.store and runtime.memory are mutually exclusive; use runtime.memory (ctx.store keeps working on top of it)",
      path: "runtime.store",
    });
  }

  const storeBackend = store && store.enabled !== false ? (store.backend ?? "memory") : undefined;
  const wantsDurable =
    (mem && (mem.backend ?? "checkpoint") === "checkpoint") || storeBackend === "sqlite" || storeBackend === "postgres";
  if (wantsDurable) {
    const ck = durableCheckpoint(spec);
    const what = mem ? "runtime.memory" : `runtime.store.backend "${String(storeBackend)}"`;
    if (!ck) {
      out.push({
        severity: "error",
        code: "MEMORY_BACKEND_UNAVAILABLE",
        message: `${what} needs a durable checkpointer; set runtime.checkpoint.backend: sqlite` +
          (mem ? " (or runtime.memory.backend: memory for tests)" : ""),
        path: mem ? "runtime.memory.backend" : "runtime.store.backend",
      });
    } else if (!mem && storeBackend !== ck) {
      out.push({
        severity: "error",
        code: "MEMORY_BACKEND_UNAVAILABLE",
        message: `runtime.store.backend "${String(storeBackend)}" must match runtime.checkpoint.backend "${ck}" — memory lives in the checkpoint database`,
        path: "runtime.store.backend",
      });
    }
  }
  if (mem?.backend === "memory") {
    out.push({
      severity: "warning",
      code: "MEMORY_BACKEND_EPHEMERAL",
      message: "runtime.memory.backend: memory is process-local and lost on exit; use it for tests only",
      path: "runtime.memory.backend",
    });
  }

  const limits = mem?.limits;
  if (limits) {
    for (const [k, capV] of Object.entries(MEMORY_HARD_CAPS)) {
      const v = (limits as Record<string, unknown>)[k];
      if (typeof v === "number" && v > capV) {
        out.push({
          severity: "error",
          code: "MEMORY_LIMIT_EXCEEDS_CAP",
          message: `runtime.memory.limits.${k} is ${v}; the hard cap is ${capV}`,
          path: `runtime.memory.limits.${k}`,
        });
      }
    }
  }

  walkNodes(spec, (node, path) => {
    if ((node as { type?: unknown }).type !== "memory") return;
    const id = String((node as { id?: unknown }).id ?? "?");
    const w = ((node as { with?: Record<string, unknown> }).with ?? {}) as Record<string, unknown>;
    if (!mem) {
      out.push({
        severity: "error",
        code: "MEMORY_NOT_CONFIGURED",
        message: `memory node "${id}" needs runtime.memory`,
        path,
      });
    }
    const op = String(w["op"] ?? "");
    const scopes = [
      ...(typeof w["scope"] === "string" ? [w["scope"]] : []),
      ...(Array.isArray(w["scopes"]) ? (w["scopes"] as unknown[]) : []),
    ];
    if (scopes.includes("subject") && mem && !mem.subject) {
      out.push({
        severity: "error",
        code: "MEMORY_SUBJECT_UNDECLARED",
        message: `memory node "${id}" uses scope subject but runtime.memory.subject is not declared`,
        path: `nodes.${id}.with.scope`,
      });
    }
    if (WRITE_OPS.has(op) && w["scope"] === undefined) {
      out.push({
        severity: "warning",
        code: "MEMORY_SCOPE_IMPLICIT",
        message: `memory node "${id}" writes without a scope; it defaults to user (or graph when the run has no user). Name the scope explicitly`,
        path: `nodes.${id}.with.scope`,
      });
    }
  });

  return out;
}

/**
 * Host-specific checks: which durable checkpoint backends this host can put
 * memory in. The CLI supports sqlite today; postgres memory lands with the server work.
 */
export function memoryHostDiagnostics(
  spec: GraphSpec,
  host: { memoryBackends: readonly string[]; hostName: string },
): Diagnostic[] {
  const mem = spec.runtime?.memory;
  const store = spec.runtime?.store;
  const storeBackend = store && store.enabled !== false ? (store.backend ?? "memory") : undefined;
  const wantsDurable =
    (mem && (mem.backend ?? "checkpoint") === "checkpoint") || storeBackend === "sqlite" || storeBackend === "postgres";
  const ck = durableCheckpoint(spec);
  if (!wantsDurable || !ck || host.memoryBackends.includes(ck)) return [];
  return [
    {
      severity: "error",
      code: "MEMORY_BACKEND_UNAVAILABLE",
      message: `${host.hostName} cannot store ${mem ? "runtime.memory" : "runtime.store"} in a ${ck} checkpointer yet (supported: ${host.memoryBackends.join(", ") || "none"})`,
      path: mem ? "runtime.memory.backend" : "runtime.store.backend",
    },
  ];
}
