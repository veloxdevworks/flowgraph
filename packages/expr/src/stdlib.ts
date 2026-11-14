/**
 * The standard library of pure, side-effect-free functions available
 * in {{ expression }} blocks.
 */

import { ownValue } from "./own-property.js";

export type StdlibFn = (...args: unknown[]) => unknown;
export type Stdlib = Record<string, StdlibFn>;

function toStr(v: unknown): string {
  return v == null ? "" : String(v);
}

function toNum(v: unknown): number {
  return Number(v);
}

function toArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

export const stdlib: Stdlib = {
  // String
  lower: (s) => toStr(s).toLowerCase(),
  upper: (s) => toStr(s).toUpperCase(),
  trim: (s) => toStr(s).trim(),
  split: (s, sep) => toStr(s).split(toStr(sep)),
  join: (arr, sep) =>
    toArr(arr)
      .map(toStr)
      .join(toStr(sep ?? "")),
  replace: (s, search, repl) => toStr(s).replaceAll(toStr(search), toStr(repl)),
  contains: (s, sub) => toStr(s).includes(toStr(sub)),
  startsWith: (s, prefix) => toStr(s).startsWith(toStr(prefix)),
  endsWith: (s, suffix) => toStr(s).endsWith(toStr(suffix)),
  slice: (s, start, end) => toStr(s).slice(toNum(start), end != null ? toNum(end) : undefined),
  format: (template, ...args) => {
    let i = 0;
    return toStr(template).replace(/\{\}/g, () => toStr(args[i++]));
  },
  len: (v) => {
    if (typeof v === "string") return v.length;
    if (Array.isArray(v)) return v.length;
    if (v != null && typeof v === "object") return Object.keys(v as object).length;
    return 0;
  },

  // Array
  map: (arr, fn) => {
    if (typeof fn !== "function") throw new Error("map: second arg must be a function");
    return toArr(arr).map(fn as (v: unknown) => unknown);
  },
  filter: (arr, fn) => {
    if (typeof fn !== "function") throw new Error("filter: second arg must be a function");
    return toArr(arr).filter(fn as (v: unknown) => boolean);
  },
  find: (arr, fn) => {
    if (typeof fn !== "function") throw new Error("find: second arg must be a function");
    return toArr(arr).find(fn as (v: unknown) => boolean) ?? null;
  },
  first: (arr) => {
    const a = toArr(arr);
    return a[0] ?? null;
  },
  last: (arr) => {
    const a = toArr(arr);
    return a[a.length - 1] ?? null;
  },
  sort: (arr, key) => {
    const a = [...toArr(arr)];
    if (key != null) {
      const k = toStr(key);
      a.sort((x, y) => {
        const xv = ownValue(x, k);
        const yv = ownValue(y, k);
        return xv == null ? -1 : yv == null ? 1 : xv < yv ? -1 : xv > yv ? 1 : 0;
      });
    } else {
      a.sort((x, y) => (x == null ? -1 : y == null ? 1 : x < y ? -1 : x > y ? 1 : 0));
    }
    return a;
  },
  unique: (arr) => [...new Set(toArr(arr))],
  flatten: (arr) => toArr(arr).flat(Infinity),
  includes: (arr, item) => toArr(arr).includes(item),
  range: (start, end, step) => {
    const s = toNum(start);
    const e = toNum(end ?? start);
    const st = toNum(step ?? 1);
    const result: number[] = [];
    if (st > 0) for (let i = s; i < e; i += st) result.push(i);
    if (st < 0) for (let i = s; i > e; i += st) result.push(i);
    return result;
  },
  reverse: (arr) => [...toArr(arr)].reverse(),
  concat: (...arrays) => ([] as unknown[]).concat(...arrays.map(toArr)),

  // Object
  keys: (obj) => (obj != null && typeof obj === "object" ? Object.keys(obj as object) : []),
  values: (obj) => (obj != null && typeof obj === "object" ? Object.values(obj as object) : []),
  entries: (obj) =>
    obj != null && typeof obj === "object"
      ? Object.entries(obj as object).map(([k, v]) => ({ key: k, value: v }))
      : [],
  get: (obj, key) => ownValue(obj, toStr(key)),
  has: (obj, key) =>
    obj != null && typeof obj === "object" ? Object.hasOwn(obj, toStr(key)) : false,
  pick: (obj, ...keys) => {
    if (obj == null || typeof obj !== "object") return {};
    return Object.fromEntries(
      keys
        .map(toStr)
        .filter((k) => Object.hasOwn(obj, k))
        .map((k) => [k, ownValue(obj, k)]),
    );
  },
  omit: (obj, ...keys) => {
    if (obj == null || typeof obj !== "object") return {};
    const ks = new Set(keys.map(toStr));
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !ks.has(k)));
  },
  merge: (...objects) =>
    Object.fromEntries(
      objects
        .filter((o) => o != null && typeof o === "object")
        .flatMap((o) => Object.entries(o as object)),
    ),

  // Number/Math
  abs: (n) => Math.abs(toNum(n)),
  min: (...args) => Math.min(...args.map(toNum)),
  max: (...args) => Math.max(...args.map(toNum)),
  round: (n) => Math.round(toNum(n)),
  floor: (n) => Math.floor(toNum(n)),
  ceil: (n) => Math.ceil(toNum(n)),
  sum: (arr) => toArr(arr).reduce((a, b) => toNum(a) + toNum(b), 0),
  avg: (arr) => {
    const a = toArr(arr);
    return a.length === 0 ? 0 : (a.reduce((s, b) => toNum(s) + toNum(b), 0) as number) / a.length;
  },
  parseInt: (s, radix) => parseInt(toStr(s), radix != null ? toNum(radix) : 10),
  parseFloat: (s) => parseFloat(toStr(s)),

  // Logic/util
  default: (v, d) => v ?? d,
  coalesce: (...args) => args.find((a) => a != null) ?? null,
  ifElse: (cond, t, f) => (cond ? t : f),
  jsonParse: (s) => JSON.parse(toStr(s)),
  jsonStringify: (v, indent) => JSON.stringify(v, null, indent != null ? toNum(indent) : undefined),
  string: (v) => toStr(v),
  number: (v) => toNum(v),
  boolean: (v) => Boolean(v),

  // Time
  now: () => new Date().toISOString(),
  toIso: (d) => new Date(toStr(d)).toISOString(),
};
