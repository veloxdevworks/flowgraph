/**
 * The one validator for flowgraph data contracts: hitl `form` / `review` schemas, wait
 * webhook payloads, workshop output, agent `with.schema` output, skill inputs and state
 * channel item / property shapes.
 *
 * Dialect: JSON Schema draft-07, checked by Ajv. Strict about the schema itself — an
 * unknown keyword or format is an error, not ignored — and never coerces, inserts
 * defaults or drops fields from the value. Standard annotations (`title`, `description`,
 * `default`, `examples`, `$comment`, `readOnly`, `writeOnly`) are allowed; presentation
 * hints for forms belong in the node's `ui` block, not in the schema.
 */

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

export const CONTRACT_SCHEMA_DIALECT = "http://json-schema.org/draft-07/schema#";

export type ValidateJsonSchemaOptions = {
  /** Accept an unfinished value: `required` is not enforced at any depth; everything else is. */
  ignoreRequired?: boolean;
};

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keywords whose value is a single subschema. */
const SCHEMA_KEYWORDS = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
] as const;
/** Keywords whose value is a map of subschemas. */
const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "definitions", "$defs"] as const;
/** Keywords whose value is a list of subschemas. */
const SCHEMA_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;

/** Visit `schema` and every nested subschema with its JSON pointer. */
function walkSchema(schema: unknown, at: string, visit: (s: Json, at: string) => void): void {
  if (!isObj(schema)) return;
  visit(schema, at);
  for (const k of SCHEMA_KEYWORDS) walkSchema(schema[k], `${at}/${k}`, visit);
  for (const k of SCHEMA_MAP_KEYWORDS) {
    const m = schema[k];
    if (isObj(m)) for (const [name, sub] of Object.entries(m)) walkSchema(sub, `${at}/${k}/${name}`, visit);
  }
  for (const k of SCHEMA_LIST_KEYWORDS) {
    const l = schema[k];
    if (Array.isArray(l)) l.forEach((sub, i) => walkSchema(sub, `${at}/${k}/${i}`, visit));
  }
  const items = schema["items"];
  if (Array.isArray(items)) items.forEach((sub, i) => walkSchema(sub, `${at}/items/${i}`, visit));
  else walkSchema(items, `${at}/items`, visit);
  const deps = schema["dependencies"];
  if (isObj(deps)) for (const [name, sub] of Object.entries(deps)) walkSchema(sub, `${at}/dependencies/${name}`, visit);
}

/** Clear messages for shapes older flowgraph versions accepted. */
function legacyShapeProblems(schema: unknown): string[] {
  const problems: string[] = [];
  walkSchema(schema, "", (s, at) => {
    const where = at || "/";
    const types = Array.isArray(s["type"]) ? s["type"] : [s["type"]];
    if (types.includes("any")) {
      problems.push(`${where}: type "any" is not JSON Schema; omit "type" to accept any value`);
    }
    if (typeof s["required"] === "boolean") {
      problems.push(
        `${where}: "required" must be a list of property names on the parent object (for example required: [name]), not a boolean`,
      );
    }
  });
  return problems;
}

function newAjv(): Ajv {
  const ajv = new Ajv({
    allErrors: true,
    strictSchema: true,
    strictNumbers: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    allowUnionTypes: true,
    validateFormats: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  const addFormats =
    (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;
  (addFormats as unknown as (a: Ajv) => void)(ajv);
  return ajv;
}

/** A schema the contract dialect does not accept. */
export class ContractSchemaError extends Error {
  readonly code = "CONTRACT_SCHEMA_INVALID";
  readonly retryable = false;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ContractSchemaError";
  }
}

const MAX_CACHED = 500;
const compiled = new Map<string, ValidateFunction>();

function stripRequired(schema: Json): Json {
  const copy = structuredClone(schema);
  walkSchema(copy, "", (s) => {
    if (Array.isArray(s["required"])) delete s["required"];
  });
  return copy;
}

/**
 * Compile a contract schema. Throws {@link ContractSchemaError} for an unknown keyword or
 * format, a malformed keyword value, an unresolvable `$ref`, or a legacy shape.
 */
export function compileContractSchema(
  schema: Json,
  opts: ValidateJsonSchemaOptions = {},
): ValidateFunction {
  if (!isObj(schema)) throw new ContractSchemaError("schema must be an object");
  const key = `${opts.ignoreRequired ? "p" : "f"}:${JSON.stringify(schema)}`;
  const hit = compiled.get(key);
  if (hit) return hit;
  const legacy = legacyShapeProblems(schema);
  if (legacy.length > 0) throw new ContractSchemaError(legacy.join("; "));
  const { $schema, ...rest } = schema;
  if ($schema !== undefined && $schema !== CONTRACT_SCHEMA_DIALECT && $schema !== "http://json-schema.org/draft-07/schema") {
    throw new ContractSchemaError(
      `unsupported $schema "${String($schema)}"; contracts use JSON Schema draft-07 (${CONTRACT_SCHEMA_DIALECT})`,
    );
  }
  let validate: ValidateFunction;
  try {
    validate = newAjv().compile(opts.ignoreRequired ? stripRequired(rest) : rest);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    let text = message.replace(/^strict mode: /, "").replace(/ ignored in schema at path "(.*)"$/, ' at "$1"');
    if (/^unknown keyword/.test(text)) {
      text += " (contracts accept JSON Schema draft-07 keywords only; put form presentation hints in `ui`)";
    }
    throw new ContractSchemaError(text, { cause });
  }
  if (compiled.size >= MAX_CACHED) compiled.clear();
  compiled.set(key, validate);
  return validate;
}

/** Why `schema` is not a valid contract schema, or `undefined` when it is. */
export function contractSchemaProblem(schema: unknown): string | undefined {
  if (!isObj(schema)) return "schema must be an object";
  try {
    compileContractSchema(schema);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** One line per Ajv error: `<instance path> <message>`. */
export function formatContractErrors(errors: readonly ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((e) => {
      const path = e.instancePath || "/";
      const params = e.params as Record<string, unknown>;
      if (e.keyword === "additionalProperties" && typeof params["additionalProperty"] === "string") {
        return `${path} must NOT have additional property "${params["additionalProperty"]}"`;
      }
      if (e.keyword === "enum" && Array.isArray(params["allowedValues"])) {
        return `${path} ${e.message}: ${(params["allowedValues"] as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
      }
      return `${path} ${e.message}`;
    })
    .join("; ");
}

/** Errors for `value` against `schema` (formatted), or `undefined` when it conforms. */
export function contractErrors(
  value: unknown,
  schema: Json,
  opts: ValidateJsonSchemaOptions = {},
): string | undefined {
  const validate = compileContractSchema(schema, opts);
  return validate(value) ? undefined : formatContractErrors(validate.errors);
}

let codegen: boolean | undefined;
/**
 * False where the host forbids runtime code generation (a Content-Security-Policy without
 * `unsafe-eval`), which Ajv needs. Clients there leave the check to the engine.
 */
export function contractValidationAvailable(): boolean {
  if (codegen === undefined) {
    try {
      codegen = new Function("return true")() === true;
    } catch {
      codegen = false;
    }
  }
  return codegen;
}

/**
 * Validate a resume payload (hitl form / review answer, wait webhook body, workshop output)
 * against its contract. The payload must be an object.
 */
export function validateJsonSchema(
  payload: unknown,
  schema: Json | undefined,
  label: string,
  opts: ValidateJsonSchemaOptions = {},
): void {
  if (!schema) return;
  if (!isObj(payload)) {
    throw new Error(`${label}: resume payload must be an object.`);
  }
  let errors: string | undefined;
  try {
    errors = contractErrors(payload, schema, opts);
  } catch (err) {
    if (err instanceof ContractSchemaError) {
      throw new ContractSchemaError(`${label}: invalid schema: ${err.message}`, { cause: err });
    }
    throw err;
  }
  if (errors) throw new Error(`${label}: does not match schema: ${errors}`);
}
