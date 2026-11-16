import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileContractSchema,
  contractErrors,
  contractSchemaProblem,
  validateJsonSchema,
} from "./validate-json-schema.js";
import { checkWorkshopOutput } from "./workshop-output.js";
import { ChannelSchema, HitlWithSchema, WaitWithSchema, WorkshopWithSchema, AgentWithSchema } from "./schema.js";

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
    expect(WorkshopWithSchema.safeParse({ schema: { type: "object" } }).success).toBe(true);
    expect(WaitWithSchema.safeParse({ webhook: { schema: { required: ["a"] } } }).success).toBe(true);
    const hitl = HitlWithSchema.safeParse({ mode: "form", message: "m", schema: { type: "object", widget: "x" } });
    expect(hitl.success).toBe(false);
    expect(JSON.stringify(hitl.error?.issues)).toContain("invalid JSON Schema: unknown keyword");
    expect(WorkshopWithSchema.safeParse({ schema: { type: "any" } }).success).toBe(false);
    expect(WaitWithSchema.safeParse({ webhook: { schema: { required: true } } }).success).toBe(false);
    expect(AgentWithSchema.safeParse({ prompt: "p", schema: { type: "object", properties: { a: { tpye: "string" } } } }).success).toBe(false);
  });

  it("checks a templated schema after rendering instead", () => {
    expect(
      HitlWithSchema.safeParse({ mode: "form", message: "m", schema: { type: "object", properties: { pick: { enum: "{{ state.options }}" } } } }).success,
    ).toBe(true);
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

  it("leave the schema check to the engine but still apply coverage", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "Function",
      function blocked() {
        throw new EvalError("code generation from strings disallowed");
      },
    );
    const mod = await import("./workshop-output.js");
    const v = await import("./validate-json-schema.js");
    expect(v.contractValidationAvailable()).toBe(false);
    expect(mod.checkWorkshopOutput({}, { schema })).toEqual({ complete: true, unverified: true });
    expect(
      mod.checkWorkshopOutput({}, { schema, requireCoverage: true, agenda: [{ id: "a" }], coverage: {} }),
    ).toEqual({ complete: false, error: "workshop output: agenda item(s) not covered: a", unverified: true });
  });

  it("are not assumed elsewhere", () => {
    expect(checkWorkshopOutput({}, { schema }).error).toContain("must have required property 'decision'");
  });
});
