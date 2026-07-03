/**
 * slugify handler — converts text into a URL-safe slug.
 *
 * @param {{ text?: string, maxLength?: number }} input
 * @returns {{ slug: string }}
 */
export default function slugify(input) {
  const text = String(input?.text ?? "");
  let slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const max = typeof input?.maxLength === "number" ? input.maxLength : undefined;
  if (max && slug.length > max) {
    slug = slug.slice(0, max).replace(/-+$/g, "");
  }
  return { slug };
}
