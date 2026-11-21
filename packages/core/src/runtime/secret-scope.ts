import { currentEnvironment } from "../environment.js";
import { observeSecret } from "./secret-redaction.js";
import type { NodeRunContext } from "../context.js";
import { assertSecretAllowed, nodePolicyOf } from "../node-policy.js";

/** The graph's top-level `secrets:` names, set by the compiler on each graph's base context. */
export const DECLARED_SECRETS: unique symbol = Symbol.for("flowgraph.declaredSecrets");

const NONE: ReadonlySet<string> = new Set();

/** Names the running graph declared. A context the compiler did not build declares none. */
export function declaredSecretsOf(ctx: object): ReadonlySet<string> {
  return ((ctx as Record<symbol, unknown>)[DECLARED_SECRETS] as ReadonlySet<string> | undefined) ?? NONE;
}

export function undeclaredSecretMessage(name: string, where: string): string {
  return `${where} reads secret "${name}", which the graph does not declare. Add ${name} to the top-level secrets: list.`;
}

export function undeclaredBaseUrlKeyMessage(provider: string, key: string): string {
  return `Provider "${provider}" sends its default API key ${key} to baseUrl, which the graph does not declare. Add ${key} to the top-level secrets: list, or set apiKeyEnv to a declared secret.`;
}

export class UndeclaredSecretError extends Error {
  readonly code = "SECRET_UNDECLARED";
  constructor(message: string) {
    super(message);
    this.name = "UndeclaredSecretError";
  }
}

export function assertSecretDeclared(declared: ReadonlySet<string>, name: string, where: string): void {
  if (!declared.has(name)) throw new UndeclaredSecretError(undeclaredSecretMessage(name, where));
}

/**
 * Lazy, non-enumerable host secrets limited to the graph's declared names;
 * compatible with own-property expression lookup.
 */
export function secretScope(ctx: NodeRunContext): Record<string, string> {
  const declared = declaredSecretsOf(ctx);
  const check = (name: string) => {
    const where = `${ctx.nodeType} node "${ctx.nodeId}"`;
    assertSecretAllowed(nodePolicyOf(ctx), name, where);
    assertSecretDeclared(declared, name, where);
  };
  return new Proxy(Object.create(null) as Record<string, string>, {
    getOwnPropertyDescriptor: (_target, name) => {
      if (typeof name !== "string") return undefined;
      check(name);
      // Every declared name resolves (unset -> ""), so a missing secret never renders as null.
      return { configurable: true, enumerable: false };
    },
    get: (_target, name) => {
      if (typeof name !== "string") return undefined;
      check(name);
      const value = Object.hasOwn(currentEnvironment(), name) ? currentEnvironment()[name] : "";
      observeSecret(value);
      return value;
    },
  });
}
