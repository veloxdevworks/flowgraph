import type { NodeRunContext } from "../context.js";
import { assertSecretAllowed, nodePolicyOf } from "../node-policy.js";

/** Lazy, non-enumerable host secrets; compatible with own-property expression lookup. */
export function secretScope(ctx: NodeRunContext): Record<string, string> {
  const check = (name: string) =>
    assertSecretAllowed(nodePolicyOf(ctx), name, `${ctx.nodeType} node "${ctx.nodeId}"`);
  return new Proxy(Object.create(null) as Record<string, string>, {
    getOwnPropertyDescriptor: (_target, name) => {
      if (typeof name !== "string") return undefined;
      check(name);
      // Every name resolves (unset -> ""), so a missing secret never renders as null.
      return { configurable: true, enumerable: false };
    },
    get: (_target, name) => {
      if (typeof name !== "string") return undefined;
      check(name);
      return Object.hasOwn(process.env, name) ? process.env[name] : "";
    },
  });
}
