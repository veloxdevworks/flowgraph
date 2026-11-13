/** Opaque, bounded correlation pairs; keys carry no engine-specific meaning. */
export function webhookCorrelation(value: unknown, required = false): Record<string, string> {
  if (value === undefined && !required) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Webhook correlation must be an object of non-empty string pairs");
  }
  const entries = Object.entries(value);
  if (entries.length > 32 || (required && entries.length === 0)) {
    throw new Error("Webhook correlation needs between 1 and 32 pairs");
  }
  for (const [key, item] of entries) {
    if (
      !key.length ||
      key.length > 128 ||
      typeof item !== "string" ||
      !item.length ||
      item.length > 1024
    ) {
      throw new Error(
        "Webhook correlation keys must be 1–128 characters and values 1–1024 characters",
      );
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
