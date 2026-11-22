/**
 * Resolve and validate graph `inputs:` (pre-start run parameters).
 * Mirrors desktop `packages/ui-graph` validateRunInput — keep behaviors in sync.
 *
 * The contract is one list, `inputs:`. A caller's values are checked against it as they
 * are: nothing is coerced, so resolving a value twice gives the same result. Text that
 * arrives as a string (the CLI's `--input key=value`) is decoded once, by the declared
 * type, with {@link decodeCliInput} before it gets here.
 */

import { inputValueProblem, type GraphSpec, type InputField } from "@flowgraph/spec";
import { isReservedChannel } from "./node-policy.js";
import { ensureDeclaredOutputChannels } from "./runtime/validate-graph.js";

export class InputValidationError extends Error {
  /** Same code on every entry point: `compiled.run()`, the CLI and the server. */
  code = "INPUT_INVALID";
  readonly retryable = false;
  readonly issues: string[];
  readonly errors: Record<string, string>;

  constructor(issues: string[], errors: Record<string, string> = {}) {
    super(issues.join("\n"));
    this.name = "InputValidationError";
    this.issues = issues;
    this.errors = errors;
  }
}

export function isInputValidationError(err: unknown): err is InputValidationError {
  return err instanceof InputValidationError;
}

function fieldLabel(field: InputField): string {
  return field.ui?.label?.trim() || field.key;
}

/** `undefined` is a missing value. `null` is a value (a JSON `null`), not a missing one. */
function isMissing(value: unknown): boolean {
  return value === undefined;
}

function isEmptyString(value: unknown): boolean {
  return typeof value === "string" && value === "";
}

const cloneDefault = (value: unknown): unknown =>
  value !== null && typeof value === "object" ? structuredClone(value) : value;

/**
 * Apply defaults and validate `provided` against the graph `inputs` schema.
 * A key is missing only when it is absent or `undefined`; `null` is a value and is checked
 * like any other. When schema is empty/absent, returns `provided` unchanged (free-form
 * input). With `allowedKeys`, a key that is neither declared in `inputs` nor in that set is
 * an error. Throws {@link InputValidationError} aggregating every issue (never prompts).
 */
export function resolveAndValidateInput(
  inputsSchema: InputField[] | undefined | null,
  provided: Record<string, unknown> | undefined | null = {},
  allowedKeys?: ReadonlySet<string>,
): Record<string, unknown> {
  const schema = inputsSchema ?? [];
  const providedMap = { ...(provided ?? {}) };
  const result: Record<string, unknown> = { ...providedMap };
  const errors: Record<string, string> = {};
  const issues: string[] = [];

  const declared = new Set(schema.map((field) => field.key));
  if (allowedKeys) {
    for (const key of Object.keys(providedMap)) {
      if (declared.has(key) || allowedKeys.has(key) || isReservedChannel(key)) continue;
      const msg = "unknown input";
      errors[key] = msg;
      issues.push(`${msg} "${key}": declare it in inputs or state.channels`);
    }
  }

  for (const field of schema) {
    if (!field.key.trim()) {
      issues.push("input field is missing a key");
      continue;
    }
    if (field.type === "select" && (!field.options || field.options.length === 0)) {
      const msg = "select field requires options";
      errors[field.key] = msg;
      issues.push(`${fieldLabel(field)} (${field.key}): ${msg}`);
      continue;
    }

    let raw: unknown = providedMap[field.key];
    if (isMissing(raw) && field.default !== undefined) raw = cloneDefault(field.default);

    if (isMissing(raw) || (field.required && (field.type ?? "string") === "string" && isEmptyString(raw))) {
      if (field.required) {
        errors[field.key] = "required";
        issues.push(`missing required input: ${fieldLabel(field)} (${field.key})`);
      }
      delete result[field.key];
      continue;
    }

    const problem = inputValueProblem(field, raw);
    if (problem) {
      errors[field.key] = problem;
      issues.push(`${fieldLabel(field)} (${field.key}): ${problem}`);
      continue;
    }
    result[field.key] = raw;
  }

  if (issues.length > 0) {
    throw new InputValidationError(issues, errors);
  }
  return result;
}

/** What input resolution reads from a graph; `nodes` lets channels that nodes write count as declared. */
type InputSpec = Pick<GraphSpec, "inputs" | "state"> & { nodes?: GraphSpec["nodes"] };

/** The keys a run's input may set: declared inputs and the graph's state channels. */
function acceptedInputKeys(spec: InputSpec): ReadonlySet<string> {
  const channels = Object.keys(ensureDeclaredOutputChannels(spec as GraphSpec).state?.channels ?? {});
  const keys = new Set(channels);
  // A graph that declares nothing still has its one default `result` channel.
  if (keys.size === 0) keys.add("result");
  return keys;
}

/**
 * The one way a run's input is resolved, used by `compiled.run()` / `stream()` /
 * `prepare({ mode: "start" })`, the CLI and the server: the caller's values checked against
 * `inputs:` (defaults applied, required and type checks), with a key that names neither an
 * input nor a state channel rejected. Values pass through as they are, so resolving an
 * already-resolved input returns the same values.
 * Throws {@link InputValidationError} (code `INPUT_INVALID`).
 */
export function resolveGraphInput(
  spec: InputSpec,
  provided: Record<string, unknown> | undefined | null = {},
): Record<string, unknown> {
  return resolveAndValidateInput(spec.inputs, provided, acceptedInputKeys(spec));
}

type TextDecoder = (text: string) => { ok: true; value: unknown } | { ok: false; error: string };

const decodeNumber: TextDecoder = (text) => {
  const n = text.trim() === "" ? Number.NaN : Number(text);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: "expected a number" };
};

const decodeBoolean: TextDecoder = (text) => {
  const lower = text.trim().toLowerCase();
  if (lower === "true") return { ok: true, value: true };
  if (lower === "false") return { ok: true, value: false };
  return { ok: false, error: "expected a boolean" };
};

const decodeJson: TextDecoder = (text) => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
};

const decodeText: TextDecoder = (text) => ({ ok: true, value: text });

const decodeJsonOrText: TextDecoder = (text) => {
  const parsed = decodeJson(text);
  return parsed.ok ? parsed : { ok: true, value: text };
};

function decoderFor(spec: Pick<GraphSpec, "inputs" | "state">, key: string): TextDecoder {
  const field = (spec.inputs ?? []).find((f) => f.key === key);
  if (field) {
    switch (field.type ?? "string") {
      case "number": return decodeNumber;
      case "boolean": return decodeBoolean;
      case "json": return decodeJson;
      default: return decodeText;
    }
  }
  switch (spec.state?.channels?.[key]?.type) {
    case "number": return decodeNumber;
    case "boolean": return decodeBoolean;
    case "object":
    case "array": return decodeJson;
    case "string": return decodeText;
    case "any":
    case "messages": return decodeJsonOrText;
    default: return decodeText;
  }
}

/**
 * Decode text values (the CLI's `--input key=value`) once, by the declared type: a number or
 * boolean input is parsed, a `json` input is JSON text, a `string` or `select` input is kept
 * as written. A key that is not an input is decoded by its channel's type (`any` takes JSON
 * when the text is valid JSON and the text itself otherwise); one that is neither stays text,
 * and {@link resolveGraphInput} rejects it. Throws {@link InputValidationError}.
 *
 * The result holds typed values, which {@link resolveGraphInput} checks without changing, so
 * a value is never decoded twice.
 */
export function decodeCliInput(
  spec: Pick<GraphSpec, "inputs" | "state">,
  text: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const issues: string[] = [];
  for (const [key, value] of Object.entries(text)) {
    const decoded = decoderFor(spec, key)(value);
    if (decoded.ok) {
      out[key] = decoded.value;
      continue;
    }
    const field = (spec.inputs ?? []).find((f) => f.key === key);
    errors[key] = decoded.error;
    issues.push(`${field ? fieldLabel(field) : key} (${key}): ${decoded.error}`);
  }
  if (issues.length > 0) throw new InputValidationError(issues, errors);
  return out;
}
