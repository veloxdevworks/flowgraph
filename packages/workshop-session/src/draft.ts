/** Pure helpers for editing the workshop draft: dot paths and deep merge. All immutable. */

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Split `a.b.0.c` into segments. Throws on empty paths and prototype-polluting keys. */
export function parsePath(path: string): string[] {
  if (typeof path !== "string" || path.trim() === "") throw new Error("path must be a non-empty string");
  const segs = path.split(".").map((s) => s.trim());
  for (const s of segs) {
    if (s === "") throw new Error(`invalid path '${path}': empty segment`);
    if (FORBIDDEN.has(s)) throw new Error(`invalid path '${path}': '${s}' is not allowed`);
  }
  return segs;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of parsePath(path)) {
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (isPlainObject(cur)) cur = Object.hasOwn(cur, seg) ? cur[seg] : undefined;
    else return undefined;
  }
  return cur;
}

function setIn(node: unknown, segs: string[], i: number, value: unknown): unknown {
  if (i === segs.length) return value;
  const seg = segs[i]!;
  const here = segs.slice(0, i + 1).join(".");
  if (Array.isArray(node)) {
    const idx = Number(seg);
    if (!Number.isInteger(idx) || idx < 0) throw new Error(`cannot set '${here}': array index expected`);
    const copy = node.slice();
    copy[idx] = setIn(node[idx], segs, i + 1, value);
    return copy;
  }
  const base = node === undefined || node === null ? {} : node;
  if (!isPlainObject(base)) {
    throw new Error(`cannot set '${here}': '${segs.slice(0, i).join(".")}' is not an object`);
  }
  const prev = Object.hasOwn(base, seg) ? base[seg] : undefined;
  return { ...base, [seg]: setIn(prev, segs, i + 1, value) };
}

/** Return a copy of `obj` with `value` at `path`; missing intermediate objects are created. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  return setIn(obj, parsePath(path), 0, value) as Record<string, unknown>;
}

/** Deep-merge `patch` into `base`: objects merge recursively, arrays and scalars are replaced. */
export function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN.has(key)) continue;
    const next = patch[key];
    const prev = Object.hasOwn(out, key) ? out[key] : undefined;
    out[key] = isPlainObject(next) && isPlainObject(prev) ? deepMerge(prev, next) : next;
  }
  return out;
}

/** Append `item` to the array at `path` (created when absent). */
export function appendPath(obj: Record<string, unknown>, path: string, item: unknown): Record<string, unknown> {
  const existing = getPath(obj, path);
  if (existing !== undefined && existing !== null && !Array.isArray(existing)) {
    throw new Error(`'${path}' is not a list`);
  }
  return setPath(obj, path, [...((existing as unknown[] | undefined | null) ?? []), item]);
}
