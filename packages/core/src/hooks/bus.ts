/**
 * HookBus — registers hooks and runs them at lifecycle phases.
 *
 * Resolution rules:
 *   - hooks run in priority order (lower first), then registration order;
 *   - `mutate` directives chain (applied to the payload, visible to later hooks);
 *   - the first `veto` / `route` / `retry` / `interrupt` directive short-circuits
 *     and is returned as the controlling directive.
 */

import type { EventBus } from "../events.js";
import type { Hook, HookContext, HookDirective, HookPhase, HookPayload, HookWhere } from "./types.js";

export interface HookRunResult {
  /** The (possibly mutated) payload after all observe/mutate hooks. */
  payload: HookPayload;
  /** The first controlling directive, if any. */
  control?: HookDirective;
}

export interface HookBus {
  register(hook: Hook): () => void;
  run(phase: HookPhase, ctx: Omit<HookContext, "phase">): Promise<HookRunResult>;
  has(phase: HookPhase): boolean;
}

function matches(where: HookWhere | undefined, payload: HookPayload): boolean {
  if (!where) return true;
  if (where.nodeId !== undefined && payload.nodeId !== where.nodeId) return false;
  if (where.nodeType !== undefined && payload.nodeType !== where.nodeType) return false;
  if (where.tool !== undefined && payload.tool !== where.tool) return false;
  if (where.channel !== undefined) {
    const update = payload.update ?? {};
    if (!(where.channel in update)) return false;
  }
  return true;
}

export function createHookBus(events?: EventBus): HookBus {
  const byPhase = new Map<HookPhase, Hook[]>();

  function register(hook: Hook): () => void {
    const list = byPhase.get(hook.phase) ?? [];
    list.push(hook);
    list.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    byPhase.set(hook.phase, list);
    return () => {
      const cur = byPhase.get(hook.phase);
      if (cur) byPhase.set(hook.phase, cur.filter((h) => h !== hook));
    };
  }

  async function run(phase: HookPhase, ctx: Omit<HookContext, "phase">): Promise<HookRunResult> {
    const hooks = byPhase.get(phase);
    let payload = ctx.payload;
    if (!hooks || hooks.length === 0) return { payload };

    for (const hook of hooks) {
      if (!matches(hook.where, payload)) continue;
      let result;
      try {
        result = await hook.handler({ ...ctx, phase, payload });
      } catch (err) {
        events?.emit("hook.error", { phase, hook: hook.name, error: String(err) });
        continue; // a throwing observe-hook must not break the run
      }
      if (!result) continue;

      events?.emit("hook.invoked", { phase, hook: hook.name, directive: result.kind });

      if (result.kind === "mutate") {
        payload = { ...payload, ...result.payload };
        continue;
      }
      // Controlling directive — short-circuit.
      return { payload, control: result };
    }
    return { payload };
  }

  function has(phase: HookPhase): boolean {
    return (byPhase.get(phase)?.length ?? 0) > 0;
  }

  return { register, run, has };
}
