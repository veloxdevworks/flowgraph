/** Load-time environment expansion is limited to config/runtime values. */
import type { Diagnostic } from "@flowgraph/spec";
export const LOAD_TIME_ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)(?::-(.*?))?\}/g;
/** @deprecated Node bodies are now literal; retained for source compatibility. */
export const NODE_BODY_ENV_EXPANSION = "NODE_BODY_ENV_EXPANSION";
/** @deprecated Node bodies no longer collide with load-time interpolation. */
export function envExpansionCollisionDiagnostics(_raw: string): Diagnostic[] { return []; }
