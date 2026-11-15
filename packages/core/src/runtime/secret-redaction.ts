import { AsyncLocalStorage } from "node:async_hooks";

/** Shared by embedded graphs during an invocation; never enumerates the host environment. */
export class SecretRedaction {
  private readonly values = new Set<string>();
  private readonly patterns = new Map<string, RegExp>();
  private readonly headers = new Set<string>();
  constructor(patterns: RegExp[] = [], headers: string[] = []) {
    for (const name of [
      "authorization",
      "proxy-authorization",
      "cookie",
      "set-cookie",
      "x-api-key",
      "api-key",
      "x-auth-token",
      ...headers,
    ])
      this.headers.add(name.toLowerCase());
    for (const p of patterns) this.patterns.set(String(p), p);
  }
  observe(value: string | undefined): void {
    if (value) this.values.add(value);
  }
  observeHeaders(headers: Record<string, unknown> | undefined): void {
    for (const [key, value] of Object.entries(headers ?? {}))
      if (
        this.headers.has(key.toLowerCase()) &&
        typeof value === "string" &&
        value !== "***" &&
        value !== "[REDACTED]"
      ) {
        this.observe(value);
        if (/^Bearer\s+/i.test(value)) this.observe(value.replace(/^Bearer\s+/i, ""));
      }
  }
  absorb(other: SecretRedaction): void {
    for (const name of other.headers) this.headers.add(name);
    for (const value of other.values) this.values.add(value);
    for (const [key, p] of other.patterns) this.patterns.set(key, p);
  }
  redact(value: unknown): unknown {
    const scanned = new WeakSet<object>();
    const discover = (input: unknown): void => {
      if (!input || typeof input !== "object" || scanned.has(input) || ArrayBuffer.isView(input))
        return;
      scanned.add(input);
      this.observeHeaders(input as Record<string, unknown>);
      for (const value of Object.values(input)) discover(value);
    };
    discover(value);
    const seen = new WeakMap<object, unknown>();
    const text = (input: string): string => {
      let out = input;
      for (const secret of [...this.values].sort((a, b) => b.length - a.length))
        out = out.replaceAll(secret, "[REDACTED]");
      for (const p of this.patterns.values()) out = out.replace(p, "[REDACTED]");
      return out;
    };
    const walk = (input: unknown): unknown => {
      if (typeof input === "string") return text(input);
      if (input == null || typeof input !== "object") return input;
      if (
        input instanceof Date ||
        input instanceof RegExp ||
        ArrayBuffer.isView(input) ||
        input instanceof ArrayBuffer
      )
        return input;
      if (seen.has(input)) return seen.get(input);
      const out = Array.isArray(input)
        ? []
        : (Object.create(Object.getPrototypeOf(input)) as object);
      seen.set(input, out);
      for (const key of Reflect.ownKeys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        const targetKey = typeof key === "string" && this.values.has(key) ? "[REDACTED]" : key;
        if ("value" in descriptor) descriptor.value = walk(descriptor.value);
        Object.defineProperty(out, targetKey, descriptor);
      }
      return out;
    };
    return walk(value);
  }
}
const active = new AsyncLocalStorage<SecretRedaction>();
export const SECRET_REDACTION = Symbol("flowgraph.secretRedaction");
export function observeSensitiveHeaders(headers: Record<string, unknown> | undefined): void {
  active.getStore()?.observeHeaders(headers);
}
export function observeSecret(value: string | undefined): void {
  active.getStore()?.observe(value);
}
export function redactSecrets(value: unknown, policy: SecretRedaction): unknown {
  return (active.getStore() ?? policy).redact(value);
}
export function withSecretRedaction<T>(policy: SecretRedaction, invoke: () => T): T {
  const parent = active.getStore();
  if (parent) {
    parent.absorb(policy);
    return invoke();
  }
  return active.run(policy, invoke);
}
