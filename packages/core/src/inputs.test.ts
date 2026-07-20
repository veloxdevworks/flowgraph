import { describe, expect, it } from "vitest";
import {
  isInputValidationError,
  resolveAndValidateInput,
  InputValidationError,
} from "./inputs.js";
import type { InputField } from "@veloxdevworks/flowgraph-spec";

const schema: InputField[] = [
  { key: "name", label: "Name", type: "string", required: true },
  { key: "notes", type: "text", default: "" },
  { key: "count", type: "number", required: true },
  { key: "active", type: "boolean", default: false },
  { key: "priority", type: "select", options: ["low", "high"], required: true },
];

describe("resolveAndValidateInput", () => {
  it("passes through when schema is empty", () => {
    expect(resolveAndValidateInput(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(resolveAndValidateInput([], { a: 1 })).toEqual({ a: 1 });
  });

  it("applies defaults and coerces types", () => {
    expect(
      resolveAndValidateInput(schema, {
        name: "Acme",
        count: "42",
        priority: "low",
        active: "true",
      }),
    ).toEqual({
      name: "Acme",
      notes: "",
      count: 42,
      active: true,
      priority: "low",
    });
  });

  it("throws InputValidationError for missing required fields", () => {
    try {
      resolveAndValidateInput(schema, {});
      expect.unreachable();
    } catch (err) {
      expect(isInputValidationError(err)).toBe(true);
      expect(err).toBeInstanceOf(InputValidationError);
      const e = err as InputValidationError;
      expect(e.errors.name).toBe("required");
      expect(e.message).toContain("missing required input");
    }
  });

  it("rejects invalid select value", () => {
    expect(() =>
      resolveAndValidateInput(schema, {
        name: "x",
        count: 1,
        priority: "medium",
      }),
    ).toThrow(/must be one of/);
  });

  it("parses json fields from strings and accepts objects", () => {
    const jsonSchema: InputField[] = [
      { key: "numbers", type: "json", required: true },
      { key: "ticket", type: "json", default: { subject: "hi" } },
    ];
    expect(
      resolveAndValidateInput(jsonSchema, {
        numbers: "[1, 2, 3]",
      }),
    ).toEqual({
      numbers: [1, 2, 3],
      ticket: { subject: "hi" },
    });
    expect(
      resolveAndValidateInput(jsonSchema, {
        numbers: [1, 2],
        ticket: { subject: "x", body: "y" },
      }),
    ).toEqual({
      numbers: [1, 2],
      ticket: { subject: "x", body: "y" },
    });
    expect(() =>
      resolveAndValidateInput(jsonSchema, { numbers: "{not json" }),
    ).toThrow(/invalid JSON/);
  });
});
