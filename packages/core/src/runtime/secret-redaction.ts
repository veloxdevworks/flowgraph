import { AsyncLocalStorage } from "node:async_hooks";

/** The one marker that replaces a redacted value, in text and in masked header values alike. */
export const REDACTED = "[REDACTED]";

const DEFAULT_SENSITIVE_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
];

const CREDENTIAL_COOKIE_NAME = /sess|sid|token|auth|jwt|secret|key|csrf|xsrf|login|remember|refresh|access/i;

/**
 * The parts of a Set-Cookie header to redact: `name=value` whenever the value is non-empty, and the
 * bare value only when it is long enough to be a credential rather than an ordinary word or flag
 * (16+ characters, or 8+ under a credential-like cookie name). Masking `default` or `true` would
 * corrupt unrelated run data.
 */
export function setCookieRedactions(header: string): string[] {
  const pair = header.split(";", 1)[0]!.trim();
  const eq = pair.indexOf("=");
  const name = eq < 0 ? "" : pair.slice(0, eq).trim();
  const value = (eq < 0 ? pair : pair.slice(eq + 1)).trim().replace(/^"(.*)"$/, "$1");
  if (!value) return [];
  const out = eq < 0 ? [] : [pair];
  if (value.length >= 16 || (value.length >= 8 && CREDENTIAL_COOKIE_NAME.test(name))) out.push(value);
  return out;
}

/** Shared by embedded graphs during an invocation; never enumerates the host environment. */
export class SecretRedaction {
  private readonly values = new Set<string>();
  private readonly patterns = new Map<string, RegExp>();
  private readonly headers = new Set<string>();
  constructor(patterns: RegExp[] = [], headers: string[] = []) {
    for (const name of [...DEFAULT_SENSITIVE_HEADERS, ...headers]) this.headers.add(name.toLowerCase());
    for (const p of patterns) this.patterns.set(String(p), p);
  }
  observe(value: string | undefined): void {
    if (value) this.values.add(value);
  }
  isSensitiveHeader(name: string): boolean {
    return this.headers.has(name.toLowerCase());
  }
  observeHeaders(headers: Record<string, unknown> | undefined): void {
    for (const [key, value] of Object.entries(headers ?? {}))
      if (this.isSensitiveHeader(key) && typeof value === "string" && value !== "***" && value !== REDACTED) {
        this.observe(value);
        if (/^Bearer\s+/i.test(value)) this.observe(value.replace(/^Bearer\s+/i, ""));
        if (key.toLowerCase() === "set-cookie") for (const part of setCookieRedactions(value)) this.observe(part);
      }
  }
  /** A per-invocation copy: values observed during one invocation never reach another. */
  fork(): SecretRedaction {
    const copy = new SecretRedaction([...this.patterns.values()], [...this.headers]);
    for (const value of this.values) copy.values.add(value);
    return copy;
  }
  absorb(other: SecretRedaction): void {
    for (const name of other.headers) this.headers.add(name);
    for (const value of other.values) this.values.add(value);
    for (const [key, p] of other.patterns) this.patterns.set(key, p);
  }
  redact(value: unknown): unknown {
    const seen = new WeakMap<object, unknown>();
    const text = (input: string): string => {
      let out = input;
      for (const secret of [...this.values].sort((a, b) => b.length - a.length))
        out =
          secret.length >= 6
            ? out.replaceAll(secret, REDACTED)
            : out === secret
              ? REDACTED
              : out;
      for (const p of this.patterns.values()) out = out.replace(p, REDACTED);
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
        const targetKey =
          typeof key === "string" &&
          key.length >= 6 &&
          !Array.isArray(input) &&
          this.values.has(key)
            ? REDACTED
            : key;
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
/** Replace sensitive header values, including names in `runtime.secrets.redact.headers`, with {@link REDACTED}. */
export function maskSensitiveHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const policy = active.getStore();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {}))
    out[key] = (policy ? policy.isSensitiveHeader(key) : DEFAULT_SENSITIVE_HEADERS.includes(key.toLowerCase()))
      ? REDACTED
      : value;
  return out;
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
  return active.run(policy.fork(), invoke);
}
