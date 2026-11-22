import { describe, expect, it } from "vitest";
import {
  decodeCliInput,
  isInputValidationError,
  resolveAndValidateInput,
  resolveGraphInput,
  InputValidationError,
} from "./inputs.js";
import type { GraphSpec, InputField } from "@flowgraph/spec";

const schema: InputField[] = [
  { key: "name", type: "string", required: true, ui: { label: "Name" } },
  { key: "notes", type: "string", default: "", ui: { widget: "textarea" } },
  { key: "count", type: "number", required: true },
  { key: "active", type: "boolean", default: false },
  { key: "priority", type: "select", options: ["low", "high"], required: true },
];

const thrown = (fn: () => unknown): InputValidationError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(InputValidationError);
    return err as InputValidationError;
  }
  throw new Error("expected the call to throw");
};

describe("resolveAndValidateInput", () => {
  it("passes through when schema is empty", () => {
    expect(resolveAndValidateInput(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(resolveAndValidateInput([], { a: 1 })).toEqual({ a: 1 });
  });

  it("applies defaults and keeps values as they are", () => {
    expect(
      resolveAndValidateInput(schema, { name: "Acme", count: 42, priority: "low", active: true }),
    ).toEqual({ name: "Acme", notes: "", count: 42, active: true, priority: "low" });
  });

  it("resolving a resolved input changes nothing", () => {
    const once = resolveAndValidateInput(schema, { name: "Acme", count: 42, priority: "low" });
    expect(resolveAndValidateInput(schema, once)).toEqual(once);
  });

  it("does not coerce text into a number or a boolean", () => {
    const e = thrown(() => resolveAndValidateInput(schema, { name: "x", count: "42", priority: "low", active: "true" }));
    expect(e.errors).toEqual({ count: "expected a number", active: "expected a boolean" });
  });

  it("throws InputValidationError for missing required fields", () => {
    try {
      resolveAndValidateInput(schema, {});
      expect.unreachable();
    } catch (err) {
      expect(isInputValidationError(err)).toBe(true);
      const e = err as InputValidationError;
      expect(e.code).toBe("INPUT_INVALID");
      expect(e.errors.name).toBe("required");
      expect(e.message).toContain("missing required input: Name (name)");
    }
  });

  it("rejects invalid select value", () => {
    expect(() => resolveAndValidateInput(schema, { name: "x", count: 1, priority: "medium" })).toThrow(/must be one of/);
  });

  it("treats undefined as missing and null as a value", () => {
    const fields: InputField[] = [
      { key: "a", type: "string", default: "fallback" },
      { key: "b", type: "json" },
      { key: "c", type: "string" },
    ];
    expect(resolveAndValidateInput(fields, { a: undefined })).toEqual({ a: "fallback" });
    expect(resolveAndValidateInput(fields, { b: null })).toEqual({ a: "fallback", b: null });
    expect(thrown(() => resolveAndValidateInput(fields, { c: null })).errors).toEqual({ c: "expected a string" });
    expect(thrown(() => resolveAndValidateInput(fields, { a: null })).errors).toEqual({ a: "expected a string" });
  });

  it("gives each run its own copy of a default", () => {
    const fields: InputField[] = [{ key: "rows", type: "json", default: [] }];
    const first = resolveAndValidateInput(fields, {});
    (first["rows"] as unknown[]).push(1);
    expect(resolveAndValidateInput(fields, {})).toEqual({ rows: [] });
  });

  it("takes a json value of any shape, as the value and not as text", () => {
    const jsonSchema: InputField[] = [
      { key: "numbers", type: "json", required: true },
      { key: "ticket", type: "json", default: { subject: "hi" } },
    ];
    expect(resolveAndValidateInput(jsonSchema, { numbers: [1, 2, 3] })).toEqual({ numbers: [1, 2, 3], ticket: { subject: "hi" } });
    expect(resolveAndValidateInput(jsonSchema, { numbers: "[1, 2, 3]" })).toEqual({
      numbers: "[1, 2, 3]",
      ticket: { subject: "hi" },
    });
  });

  it("checks a json value against its schema", () => {
    const fields: InputField[] = [
      { key: "rows", type: "json", schema: { type: "array", items: { type: "number" } } },
    ];
    expect(resolveAndValidateInput(fields, { rows: [1, 2] })).toEqual({ rows: [1, 2] });
    expect(thrown(() => resolveAndValidateInput(fields, { rows: [1, "x"] })).errors["rows"]).toContain("does not match schema");
  });

  it("rejects a key nothing declares when the caller lists the accepted keys", () => {
    const accepted = new Set(["extra"]);
    expect(resolveAndValidateInput(schema, { name: "a", count: 1, priority: "low", extra: 1 }, accepted)).toMatchObject({ extra: 1 });
    const e = thrown(() => resolveAndValidateInput(schema, { name: "a", count: 1, priority: "low", typo: 1 }, accepted));
    expect(e.errors).toEqual({ typo: "unknown input" });
    expect(e.message).toContain('unknown input "typo"');
  });
});

describe("resolveGraphInput", () => {
  const spec = {
    inputs: [{ key: "topic", type: "string", required: true }],
    state: { channels: { notes: { type: "string" } } },
    nodes: [{ id: "n", type: "function", with: { fn: "f", output: { to: "written" } } }],
  } as unknown as GraphSpec;

  it("accepts declared inputs, state channels and channels a node writes", () => {
    expect(resolveGraphInput(spec, { topic: "x", notes: "n", written: 1 })).toEqual({ topic: "x", notes: "n", written: 1 });
  });

  it("rejects a key that is neither an input nor a channel", () => {
    const e = thrown(() => resolveGraphInput(spec, { topic: "x", nope: 1 }));
    expect(e.code).toBe("INPUT_INVALID");
    expect(e.errors).toEqual({ nope: "unknown input" });
  });

  it("lets reserved channels through for the engine", () => {
    expect(resolveGraphInput(spec, { topic: "x", __services: {} })).toMatchObject({ __services: {} });
  });
});

describe("decodeCliInput", () => {
  const spec = {
    inputs: [
      { key: "name", type: "string" },
      { key: "count", type: "number" },
      { key: "on", type: "boolean" },
      { key: "pick", type: "select", options: ["a", "1"] },
      { key: "doc", type: "json" },
    ],
    state: {
      channels: {
        total: { type: "number" },
        list: { type: "array" },
        anything: { type: "any" },
        label: { type: "string" },
      },
    },
  } as unknown as GraphSpec;

  it("keeps a string input as written, even when it looks like JSON", () => {
    expect(decodeCliInput(spec, { name: "42", pick: "1" })).toEqual({ name: "42", pick: "1" });
    expect(decodeCliInput(spec, { name: "true" })).toEqual({ name: "true" });
    expect(decodeCliInput(spec, { name: '{"a":1}' })).toEqual({ name: '{"a":1}' });
  });

  it("parses a number or boolean input by its type", () => {
    expect(decodeCliInput(spec, { count: "42", on: "TRUE" })).toEqual({ count: 42, on: true });
    expect(decodeCliInput(spec, { count: "-1.5e2" })).toEqual({ count: -150 });
  });

  it("parses a json input as JSON text", () => {
    expect(decodeCliInput(spec, { doc: '{"a":[1,2]}' })).toEqual({ doc: { a: [1, 2] } });
    expect(decodeCliInput(spec, { doc: '"text"' })).toEqual({ doc: "text" });
    expect(decodeCliInput(spec, { doc: "null" })).toEqual({ doc: null });
  });

  it("reports text that does not fit the type, naming every key", () => {
    const e = thrown(() => decodeCliInput(spec, { count: "many", on: "yes", doc: "{nope" }));
    expect(e.code).toBe("INPUT_INVALID");
    expect(e.errors).toEqual({ count: "expected a number", on: "expected a boolean", doc: "invalid JSON" });
    expect(thrown(() => decodeCliInput(spec, { count: "" })).errors).toEqual({ count: "expected a number" });
  });

  it("decodes a key that names a channel by the channel's type", () => {
    expect(decodeCliInput(spec, { total: "7", list: "[1]", label: "7" })).toEqual({ total: 7, list: [1], label: "7" });
    expect(decodeCliInput(spec, { anything: "[1]" })).toEqual({ anything: [1] });
    expect(decodeCliInput(spec, { anything: "plain words" })).toEqual({ anything: "plain words" });
  });

  it("leaves an unknown key as text for input resolution to reject", () => {
    const decoded = decodeCliInput(spec, { stray: "1" });
    expect(decoded).toEqual({ stray: "1" });
    expect(thrown(() => resolveGraphInput(spec, decoded)).errors).toEqual({ stray: "unknown input" });
  });

  it("gives the same value whether the CLI or an API caller supplies it", () => {
    const fromCli = resolveGraphInput(spec, decodeCliInput(spec, { count: "3", doc: "[1]" }));
    const fromApi = resolveGraphInput(spec, { count: 3, doc: [1] });
    expect(fromCli).toEqual(fromApi);
  });
});
