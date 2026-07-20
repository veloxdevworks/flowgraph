/**
 * Resolve and validate graph `inputs:` (pre-start run parameters).
 * Mirrors desktop `packages/ui-graph` validateRunInput — keep behaviors in sync.
 */

import type { InputField, InputFieldType } from "@veloxdevworks/flowgraph-spec";

export class InputValidationError extends Error {
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
  return field.label?.trim() || field.key;
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

function isEmptyString(value: unknown): boolean {
  return typeof value === "string" && value === "";
}

function coerceValue(
  field: InputField,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const type: InputFieldType = field.type ?? "string";

  if (type === "number") {
    if (typeof raw === "number" && Number.isFinite(raw)) return { ok: true, value: raw };
    if (typeof raw === "string" && raw.trim() !== "") {
      const n = Number(raw);
      if (Number.isFinite(n)) return { ok: true, value: n };
    }
    return { ok: false, error: "expected a number" };
  }

  if (type === "boolean") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    if (typeof raw === "string") {
      const lower = raw.trim().toLowerCase();
      if (lower === "true") return { ok: true, value: true };
      if (lower === "false") return { ok: true, value: false };
    }
    return { ok: false, error: "expected a boolean" };
  }

  if (type === "select") {
    const str = typeof raw === "string" ? raw : String(raw);
    const options = field.options ?? [];
    if (!options.includes(str)) {
      return { ok: false, error: `must be one of: ${options.join(", ") || "(none)"}` };
    }
    return { ok: true, value: str };
  }

  if (type === "json") {
    if (raw !== null && typeof raw === "object") return { ok: true, value: raw };
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed === "") return { ok: false, error: "expected JSON" };
      try {
        return { ok: true, value: JSON.parse(trimmed) as unknown };
      } catch {
        return { ok: false, error: "invalid JSON" };
      }
    }
    return { ok: false, error: "expected JSON" };
  }

  // string | text
  if (typeof raw === "string") return { ok: true, value: raw };
  if (typeof raw === "number" || typeof raw === "boolean") return { ok: true, value: String(raw) };
  return { ok: false, error: "expected a string" };
}

/**
 * Apply defaults and coerce/validate `provided` against the graph `inputs` schema.
 * When schema is empty/absent, returns `provided` unchanged (free-form input).
 * Throws {@link InputValidationError} aggregating every issue (never prompts).
 */
export function resolveAndValidateInput(
  inputsSchema: InputField[] | undefined | null,
  provided: Record<string, unknown> | undefined | null = {},
): Record<string, unknown> {
  const schema = inputsSchema ?? [];
  const providedMap = { ...(provided ?? {}) };

  if (schema.length === 0) {
    return providedMap;
  }

  const result: Record<string, unknown> = { ...providedMap };
  const errors: Record<string, string> = {};
  const issues: string[] = [];

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

    const hasProvided = Object.prototype.hasOwnProperty.call(providedMap, field.key);
    let raw: unknown = hasProvided ? providedMap[field.key] : undefined;

    if (isAbsent(raw) && field.default !== undefined) {
      raw = field.default;
    }

    if (isAbsent(raw) || (field.required && isEmptyString(raw))) {
      if (field.required) {
        const msg = "required";
        errors[field.key] = msg;
        issues.push(`missing required input: ${fieldLabel(field)} (${field.key})`);
      }
      if (hasProvided) delete result[field.key];
      continue;
    }

    const coerced = coerceValue(field, raw);
    if (!coerced.ok) {
      errors[field.key] = coerced.error;
      issues.push(`${fieldLabel(field)} (${field.key}): ${coerced.error}`);
      continue;
    }
    result[field.key] = coerced.value;
  }

  if (issues.length > 0) {
    throw new InputValidationError(issues, errors);
  }
  return result;
}
