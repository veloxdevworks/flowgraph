import {
  z,
  ZodFirstPartyTypeKind,
  ZodUnion,
  addIssueToContext,
  INVALID,
  type ParseInput,
  type ParseReturnType,
  type ZodRawShape,
  type ZodTypeAny,
} from "zod";
import { suggestKey } from "./suggest.js";

/** `Unknown field "x" (did you mean "y"?)` for each key that is not in `known`. */
export function unknownKeysMessage(keys: readonly string[], known: readonly string[]): string {
  const parts = keys.map((key) => {
    const hint = suggestKey(key, known);
    return hint ? `"${key}" (did you mean "${hint}"?)` : `"${key}"`;
  });
  return `Unknown ${keys.length === 1 ? "field" : "fields"} ${parts.join(", ")}`;
}

/**
 * An object that rejects keys it does not declare, and names the closest declared
 * key for a typo. Use it for every author-facing object; leave `z.record` for data
 * maps whose keys are the author's own (state values, headers, env-like maps).
 */
export function strictObject<T extends ZodRawShape>(shape: T) {
  const known = Object.keys(shape);
  return z
    .object(shape, {
      errorMap: (issue, ctx) =>
        issue.code === z.ZodIssueCode.unrecognized_keys
          ? { message: unknownKeysMessage(issue.keys, known) }
          : { message: ctx.defaultError },
    })
    .strict();
}

type UnionOptions = [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]];

class SelectedUnion<T extends UnionOptions> extends ZodUnion<T> {
  constructor(
    def: ConstructorParameters<typeof ZodUnion<T>>[0],
    private readonly select: (data: unknown) => number | string,
  ) {
    super(def);
  }

  override _parse(input: ParseInput): ParseReturnType<this["_output"]> {
    const { ctx } = this._processInputParams(input);
    const picked = this.select(ctx.data);
    if (typeof picked === "string") {
      addIssueToContext(ctx, { code: z.ZodIssueCode.custom, message: picked });
      return INVALID;
    }
    const option = this.options[picked];
    if (!option) {
      addIssueToContext(ctx, { code: z.ZodIssueCode.custom, message: "Invalid input" });
      return INVALID;
    }
    return option._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
}

/**
 * A union that picks its member from the value instead of trying each one, so an
 * invalid value is reported against the member it was meant to be (a typo inside it
 * names the field) rather than as "Invalid input". `select` returns the member's
 * index, or the message to report when the value fits none. It is a `ZodUnion`, so
 * types and the generated JSON Schema (`anyOf`) are those of a plain union.
 */
export function unionBy<T extends UnionOptions>(
  options: T,
  select: (data: unknown) => number | string,
): ZodUnion<T> {
  return new SelectedUnion({ options, typeName: ZodFirstPartyTypeKind.ZodUnion }, select);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `a`, `a or b`, `a, b or c`. */
function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/**
 * A union of objects told apart by which key each one is built around (`skill` /
 * `node` / `function`, or `to` / `branch`). A value with none of the keys, or with
 * more than one, is reported by name.
 */
export function keyedUnion<T extends UnionOptions>(label: string, options: T, keys: readonly string[]): ZodUnion<T> {
  return unionBy(options, (data) => {
    if (!isRecord(data)) return `${label} must be a mapping with ${orList(keys.map((k) => `"${k}"`))}`;
    const present = keys.map((key, index) => ({ key, index })).filter(({ key }) => data[key] !== undefined);
    if (present.length === 0) return `${label} needs ${orList(keys.map((k) => `"${k}"`))}`;
    if (present.length > 1) {
      return `${label} takes ${orList(keys.map((k) => `"${k}"`))}, not several (found ${orList(present.map(({ key }) => `"${key}"`))})`;
    }
    return present[0]!.index;
  });
}
