import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileContractSchema,
  contractErrors,
  contractSchemaProblem,
  validateJsonSchema,
} from "./validate-json-schema.js";
import { ChannelSchema, HitlWithSchema, WaitWithSchema, AgentWithSchema } from "./schema.js";

const schema = {
  type: "object",
  properties: {
    decision: { enum: ["approve", "reject"] },
    meta: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    tags: { type: "array", items: { type: "string" } },
    count: { type: "integer", minimum: 0 },
  },
  required: ["decision"],
  additionalProperties: false,
};

const reject = (payload: unknown, ignoreRequired = false) => {
  try {
    validateJsonSchema(payload, schema, "form", { ignoreRequired });
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
};

describe("validateJsonSchema", () => {
  it("rejects a value outside an enum", () => {
    expect(reject({ decision: "maybe" })).toBe(
      'form: does not match schema: /decision must be equal to one of the allowed values: "approve", "reject"',
    );
  });

  it("rejects a wrongly typed nested value", () => {
    expect(reject({ decision: "approve", meta: { n: "x" } })).toBe("form: does not match schema: /meta/n must be number");
  });

  it("rejects a forbidden extra property", () => {
    expect(reject({ decision: "approve", extra: 1 })).toBe(
      'form: does not match schema: / must NOT have additional property "extra"',
    );
  });

  it("rejects wrong array item types", () => {
    expect(reject({ decision: "approve", tags: ["a", 2] })).toBe("form: does not match schema: /tags/1 must be string");
  });

  it("enforces integer and numeric bounds", () => {
    expect(reject({ decision: "approve", count: 1.5 })).toContain("/count must be integer");
    expect(reject({ decision: "approve", count: -1 })).toContain("/count must be >= 0");
    expect(reject({ decision: "approve", count: 2 })).toBeUndefined();
  });

  it("reports every error, and required at the root", () => {
    expect(reject({ tags: [1] })).toBe(
      "form: does not match schema: / must have required property 'decision'; /tags/0 must be string",
    );
  });

  it("ignoreRequired skips required at every depth but nothing else", () => {
    expect(reject({ meta: {} }, true)).toBeUndefined();
    expect(reject({ meta: { n: "x" } }, true)).toContain("/meta/n must be number");
  });

  it("never coerces or inserts defaults", () => {
    const value = { decision: "approve", count: "2" };
    expect(reject(value)).toContain("/count must be integer");
    const withDefault = { type: "object", properties: { a: { type: "string", default: "x" } } };
    const v: Record<string, unknown> = {};
    expect(contractErrors(v, withDefault)).toBeUndefined();
    expect(v).toEqual({});
  });

  it("requires an object payload", () => {
    expect(() => validateJsonSchema("x", schema, "form")).toThrow("form: resume payload must be an object.");
  });

  it("reports an invalid schema as a schema error, not a payload error", () => {
    expect(() => validateJsonSchema({}, { type: "object", widget: "x" }, "form")).toThrow(
      expect.objectContaining({ code: "CONTRACT_SCHEMA_INVALID" }),
    );
  });
});

describe("contract schema dialect", () => {
  it("accepts draft-07 keywords, annotations and formats", () => {
    expect(
      contractSchemaProblem({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        title: "T",
        description: "D",
        $comment: "c",
        properties: {
          email: { type: "string", format: "email", examples: ["a@b.co"] },
          when: { type: "string", format: "date-time" },
          kind: { oneOf: [{ const: "a" }, { const: "b" }] },
          n: { type: ["integer", "null"] },
        },
        definitions: { x: { type: "string" } },
        patternProperties: { "^x-": { $ref: "#/definitions/x" } },
      }),
    ).toBeUndefined();
  });

  it("rejects unknown keywords and points form hints at `ui`", () => {
    expect(contractSchemaProblem({ type: "string", "ui:widget": "textarea" })).toMatch(
      /unknown keyword: "ui:widget".*put form presentation hints in `ui`/,
    );
    expect(contractSchemaProblem({ type: "object", properties: { a: { type: "string", placeholder: "x" } } })).toMatch(
      /unknown keyword: "placeholder"/,
    );
  });

  it("rejects unknown formats, malformed keywords and other dialects", () => {
    expect(contractSchemaProblem({ type: "string", format: "nope" })).toBe('unknown format "nope" at "#"');
    expect(contractSchemaProblem({ type: "strng" })).toMatch(/type/);
    expect(contractSchemaProblem({ $schema: "https://json-schema.org/draft/2020-12/schema" })).toMatch(
      /contracts use JSON Schema draft-07/,
    );
    expect(contractSchemaProblem({ $ref: "#/definitions/missing" })).toMatch(/missing/);
  });

  it("rejects a $ref that leaves the schema, including the draft-07 meta-schema", () => {
    const local = 'a $ref must point inside the same schema (for example "#/definitions/name")';
    expect(contractSchemaProblem({ $ref: "http://json-schema.org/draft-07/schema#" })).toBe(
      `/: $ref "http://json-schema.org/draft-07/schema#" is not local; ${local}`,
    );
    expect(contractSchemaProblem({ $ref: "http://json-schema.org/draft-07/schema" })).toContain("is not local");
    expect(contractSchemaProblem({ $ref: "https://example.invalid/s.json" })).toContain("is not local");
    expect(contractSchemaProblem({ type: "object", properties: { a: { $ref: "other.json#/x" } } })).toBe(
      `/properties/a: $ref "other.json#/x" is not local; ${local}`,
    );
    expect(() => contractErrors(1, { $ref: "http://json-schema.org/draft-07/schema#" })).toThrow("is not local");
    expect(contractSchemaProblem({ definitions: { x: { type: "string" } }, $ref: "#/definitions/x" })).toBeUndefined();
  });

  it("rejects $ref cycles that never step into the value", () => {
    const hint = "a recursive $ref must go through properties, items or similar";
    expect(contractSchemaProblem({ $ref: "#" })).toBe(`$ref cycle never reaches a value: # → #; ${hint}`);
    expect(
      contractSchemaProblem({
        definitions: { a: { allOf: [{ $ref: "#/definitions/b" }] }, b: { not: { $ref: "#/definitions/a" } } },
        $ref: "#/definitions/a",
      }),
    ).toBe(
      `$ref cycle never reaches a value: #/definitions/a → #/definitions/a/allOf/0 → #/definitions/b → #/definitions/b/not → #/definitions/a; ${hint}`,
    );
    expect(contractSchemaProblem({ definitions: { n: { $id: "#node", anyOf: [{ $ref: "#node" }] } } })).toContain(
      "$ref cycle never reaches a value",
    );
    expect(() => contractErrors({}, { $ref: "#" })).toThrow(expect.objectContaining({ code: "CONTRACT_SCHEMA_INVALID" }));
    expect(HitlWithSchema.safeParse({ mode: "form", message: "m", schema: { $ref: "#" } }).success).toBe(false);
  });

  it("allows recursion that steps into the value, and never crashes on deep or cyclic values", () => {
    const tree = { type: "object", properties: { children: { type: "array", items: { $ref: "#" } } } };
    expect(contractSchemaProblem(tree)).toBeUndefined();
    expect(contractErrors({ children: [{ children: [] }] }, tree)).toBeUndefined();
    expect(contractErrors({ children: [{ children: 1 }] }, tree)).toBe("/children/0/children must be array");
    let deep: unknown = [];
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(contractErrors(deep, { type: "array", items: { $ref: "#" } })).toBe("/ is nested too deeply to validate");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => validateJsonSchema(cyclic, { type: "object", additionalProperties: { $ref: "#" } }, "form")).toThrow(
      "form: does not match schema: / is nested too deeply to validate",
    );
  });

  it("explains the shapes earlier versions accepted", () => {
    expect(contractSchemaProblem({ type: "any" })).toBe('/: type "any" is not JSON Schema; omit "type" to accept any value');
    expect(contractSchemaProblem({ type: "object", properties: { a: { type: "string", required: true } } })).toBe(
      '/properties/a: "required" must be a list of property names on the parent object (for example required: [name]), not a boolean',
    );
  });

  it("caches compiled validators", () => {
    expect(compileContractSchema({ type: "string" })).toBe(compileContractSchema({ type: "string" }));
  });
});

describe("schemas in node config", () => {
  it("rejects an invalid contract schema at validation time", () => {
    expect(AgentWithSchema.safeParse({ prompt: "p", schema: { type: "object" } }).success).toBe(true);
    expect(WaitWithSchema.safeParse({ webhook: { schema: { required: ["a"] } } }).success).toBe(true);
    const hitl = HitlWithSchema.safeParse({ mode: "form", message: "m", schema: { type: "object", widget: "x" } });
    expect(hitl.success).toBe(false);
    expect(JSON.stringify(hitl.error?.issues)).toContain("invalid JSON Schema: unknown keyword");
    expect(WaitWithSchema.safeParse({ webhook: { schema: { required: true } } }).success).toBe(false);
    expect(AgentWithSchema.safeParse({ prompt: "p", schema: { type: "object", properties: { a: { tpye: "string" } } } }).success).toBe(false);
  });

  it("leaves only templated values that affect validation for after rendering", () => {
    const form = (schema: Record<string, unknown>) => HitlWithSchema.safeParse({ mode: "form", message: "m", schema });
    expect(form({ type: "object", properties: { pick: { enum: "{{ state.options }}" } } }).success).toBe(true);
    expect(form({ type: "object", properties: { pick: "{{ state.pickSchema }}" }, required: ["{{ state.key }}"] }).success).toBe(true);
    expect(form({ type: "{{ state.kind }}", maxLength: "{{ state.max }}" }).success).toBe(true);
  });

  it("still checks the rest of a templated schema", () => {
    const problem = (schema: Record<string, unknown>) => contractSchemaProblem(schema, { templates: true });
    // A template in a description changes nothing.
    expect(problem({ type: "object", description: "Use {{braces}}", properties: { a: { tpye: "string" } } })).toMatch(
      /unknown keyword: "tpye"/,
    );
    // A templated enum does not hide a typo elsewhere.
    expect(problem({ type: "object", properties: { pick: { enum: "{{ s.o }}" }, a: { type: "strng" } } })).toMatch(/type/);
    // An unknown keyword is reported even when its value is templated.
    expect(problem({ type: "string", placeholder: "{{ s.hint }}" })).toMatch(/unknown keyword: "placeholder"/);
    expect(problem({ type: "any", title: "{{ s.t }}" })).toContain('type "any" is not JSON Schema');
    expect(problem({ $ref: "http://json-schema.org/draft-07/schema#", description: "{{ x }}" })).toContain("is not local");
    expect(
      HitlWithSchema.safeParse({
        mode: "form",
        message: "m",
        schema: { type: "object", description: "Answers for {{ state.topic }}", properties: { a: { tpye: "string" } } },
      }).success,
    ).toBe(false);
  });

  it("keeps form presentation hints in `ui`", () => {
    const ok = HitlWithSchema.safeParse({
      mode: "form",
      message: "m",
      schema: { type: "object", properties: { notes: { type: "string" } } },
      ui: { order: ["notes"], fields: { notes: { label: "Notes", widget: "textarea", placeholder: "…", help: "h" } } },
    });
    expect(ok.success).toBe(true);
    expect(HitlWithSchema.safeParse({ mode: "form", message: "m", ui: { fields: { a: { colour: "red" } } } }).success).toBe(false);
    expect(HitlWithSchema.safeParse({ mode: "form", message: "m", ui: { fields: { a: { widget: "slider" } } } }).success).toBe(false);
  });

  it("channel items / properties use the same dialect", () => {
    expect(ChannelSchema.safeParse({ type: "array", items: { type: "integer" } }).success).toBe(true);
    expect(ChannelSchema.safeParse({ type: "object", properties: { a: { type: "any" } } }).success).toBe(false);
    expect(ChannelSchema.safeParse({ type: "object", properties: { a: { type: "string", required: true } } }).success).toBe(false);
  });
});

describe("hosts without runtime code generation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("reports contractValidationAvailable() as false", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "Function",
      function blocked() {
        throw new EvalError("code generation from strings disallowed");
      },
    );
    const v = await import("./validate-json-schema.js");
    expect(v.contractValidationAvailable()).toBe(false);
  });
});
