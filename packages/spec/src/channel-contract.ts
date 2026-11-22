/**
 * The data contract of a state channel (and of a declared subgraph output): the
 * `type` shorthand, or an explicit draft-07 `schema`. When a `schema` is given it is
 * the only thing checked, and `type` must agree with its top-level `type`.
 */

import { compileContractSchema, formatContractErrors } from "./validate-json-schema.js";

type Json = Record<string, unknown>;

export type ChannelContractInput = {
  type?: string | undefined;
  schema?: Json | undefined;
};

const SHORTHAND_TYPES: Readonly<Record<string, (value: unknown) => boolean>> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
};

/** JSON Schema `type` names a channel `type` can agree with. */
const COMPATIBLE_SCHEMA_TYPES: Readonly<Record<string, readonly string[]>> = {
  string: ["string"],
  number: ["number", "integer"],
  boolean: ["boolean"],
  object: ["object"],
  array: ["array"],
  messages: ["array"],
};

/** Why `schema` contradicts the channel `type`, or `undefined` when they agree (or nothing is declared). */
export function channelTypeConflict(channel: ChannelContractInput): string | undefined {
  const { type, schema } = channel;
  if (!type || !schema) return undefined;
  const allowed = COMPATIBLE_SCHEMA_TYPES[type];
  const declared = schema["type"];
  if (!allowed || declared === undefined) return undefined;
  const names = (Array.isArray(declared) ? declared : [declared]).filter((n): n is string => typeof n === "string");
  if (names.length === 0 || names.some((n) => allowed.includes(n))) return undefined;
  return `schema type ${names.join(" | ")} conflicts with type: ${type}`;
}

/** Checks `value` against the contract: a problem text (`<path> <problem>`), or `undefined` when it conforms. */
export type ChannelContractCheck = (value: unknown) => string | undefined;

/**
 * The check for a channel's contract, or `undefined` when nothing constrains it (`type: any`,
 * `type: messages` and no schema). Throws `ContractSchemaError` for a schema the dialect rejects.
 */
export function compileChannelContract(channel: ChannelContractInput): ChannelContractCheck | undefined {
  if (channel.schema) {
    const validate = compileContractSchema(channel.schema);
    return (value) => {
      let ok: boolean;
      try {
        ok = validate(value) as boolean;
      } catch (err) {
        if (err instanceof RangeError) return "/ is nested too deeply to validate";
        throw err;
      }
      return ok ? undefined : formatContractErrors(validate.errors);
    };
  }
  const check = channel.type ? SHORTHAND_TYPES[channel.type] : undefined;
  if (check) return (value) => (check(value) ? undefined : `/ must be ${channel.type}`);
  if (channel.type === "array") return (value) => (Array.isArray(value) ? undefined : "/ must be array");
  return undefined;
}

/**
 * A problem with the contract itself (an invalid schema, or a `type` the schema contradicts),
 * or `undefined` when it is sound.
 */
export function channelContractProblem(channel: ChannelContractInput): string | undefined {
  if (channel.schema) {
    try {
      compileContractSchema(channel.schema);
    } catch (err) {
      return `invalid JSON Schema: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return channelTypeConflict(channel);
}

/** Whether `value` conforms to a channel's contract (`type: messages` accepts any array). */
export function channelValueProblem(channel: ChannelContractInput, value: unknown): string | undefined {
  if (!channel.schema && channel.type === "messages") return Array.isArray(value) ? undefined : "/ must be array";
  return compileChannelContract(channel)?.(value);
}

/** The channel a declared input is seeded into when the graph does not declare one under `state.channels`. */
export function inputFieldChannel(field: {
  type?: string | undefined;
  schema?: Json | undefined;
}): { type: "string" | "number" | "boolean" | "any"; schema?: Json } {
  const type = field.type === "number" || field.type === "boolean" ? field.type : field.type === "json" ? "any" : "string";
  return { type, ...(field.schema ? { schema: field.schema } : {}) };
}
