/** Shared by member access and object helpers so neither can walk prototypes. */
export function ownValue(obj: unknown, key: PropertyKey): unknown {
  if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) return null;
  return Object.hasOwn(obj, key) ? ((obj as Record<PropertyKey, unknown>)[key] ?? null) : null;
}
