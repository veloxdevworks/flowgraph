import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphSpec } from "@flowgraph/spec";
import { loadSkill } from "@flowgraph/skills";
import { compileGraph } from "./compiler.js";
import { validateSpec } from "./loader.js";
import { validateAgentOutput } from "./runtime/agent-output.js";
import { parseWebhookPayload } from "./runtime/webhook-payload.js";
import { runSkill } from "./nodes/skill-runner.js";
import type { NodeRunContext } from "./context.js";

const schema = {
  type: "object",
  properties: {
    decision: { enum: ["approve", "reject"] },
    meta: { type: "object", properties: { n: { type: "number" } } },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["decision"],
  additionalProperties: false,
};

const BAD = [
  [{ decision: "maybe" }, '/decision must be equal to one of the allowed values: "approve", "reject"'],
  [{ decision: "approve", meta: { n: "x" } }, "/meta/n must be number"],
  [{ decision: "approve", extra: true }, '/ must NOT have additional property "extra"'],
  [{ decision: "approve", tags: [1] }, "/tags/0 must be string"],
] as const;

function single(node: Record<string, unknown>, channels: Record<string, unknown> = { out: { type: "object" } }): GraphSpec {
  return {
    apiVersion: "flowgraph/v1",
    kind: "Graph",
    metadata: { name: "contract-schema" },
    state: { channels },
    nodes: [{ id: "gate", ...node }],
    edges: [
      { from: "START", to: "gate" },
      { from: "gate", to: "END" },
    ],
    runtime: { checkpoint: { enabled: true, backend: "memory" } },
  } as unknown as GraphSpec;
}

describe("one contract validator", () => {
  it.each(BAD)("hitl form re-prompts %j with the same message as agent output", async (answer, message) => {
    const g = await compileGraph(
      single({ type: "hitl", with: { mode: "form", message: "Fill in", schema, output: { to: "out" } } }),
      {},
    );
    const threadId = `cs-form-${message.length}`;
    await g.run({ threadId, onInterrupt: "fail" });
    const r = await g.resume({ threadId, resume: answer, onInterrupt: "fail" });
    expect(r.status).toBe("interrupted");
    expect(r.interrupts?.[0]?.validationError).toBe(`hitl node "gate" form: does not match schema: ${message}`);
    expect(() => validateAgentOutput(answer, schema, "agent node \"a\"")).toThrow(
      `agent node "a": output does not match schema: ${message}`,
    );
  });

  // An unknown decision is refused by the decision check before the schema runs.
  it.each(BAD.slice(1))("hitl review rejects %j", async (answer, message) => {
    const reviewSchema = { ...schema, properties: { ...schema.properties, approved: { type: "boolean" }, feedback: { type: "string" } } };
    const g = await compileGraph(
      single({ type: "hitl", with: { mode: "review", message: "Review", schema: reviewSchema, decision: ["approve", "reject"], output: { to: "out" } } }),
      {},
    );
    const threadId = `cs-review-${message.length}`;
    await g.run({ threadId, onInterrupt: "fail" });
    const r = await g.resume({ threadId, resume: answer, onInterrupt: "fail" });
    expect(r.status).toBe("interrupted");
    expect(r.interrupts?.[0]?.validationError).toContain(message);
  });

  it.each(BAD)("wait webhook rejects %j", (answer, message) => {
    expect(() => parseWebhookPayload(answer, schema, "w")).toThrow(`wait node "w": does not match schema: ${message}`);
  });

  it.each(BAD)("workshop output rejects %j", async (answer, message) => {
    const g = await compileGraph(
      single({ type: "workshop", with: { message: "W", agenda: ["scope"], schema, output: { to: "out" } } }),
      {},
    );
    const threadId = `cs-ws-${message.length}`;
    await g.run({ threadId, onInterrupt: "fail" });
    const r = await g.resume({ threadId, resume: { output: answer }, onInterrupt: "fail" });
    expect(r.status).toBe("interrupted");
    expect(r.interrupts?.[0]?.validationError).toBe(`workshop node "gate" output: does not match schema: ${message}`);
  });

  it("accepts a conforming answer and passes `ui` hints through on the interrupt", async () => {
    const ui = { order: ["decision"], fields: { decision: { label: "Decision", widget: "radio" } } };
    const g = await compileGraph(
      single({ type: "hitl", with: { mode: "form", message: "Fill in", schema, ui, output: { to: "out" } } }),
      {},
    );
    const first = await g.run({ threadId: "cs-ok", onInterrupt: "fail" });
    expect(first.interrupts?.[0]?.payload).toMatchObject({ data: { schema, ui } });
    const r = await g.resume({ threadId: "cs-ok", resume: { decision: "approve", tags: ["a"] }, onInterrupt: "fail" });
    expect(r.status).toBe("completed");
  });
});

describe("invalid contract schemas", () => {
  it("are reported by validateSpec", () => {
    const diags = validateSpec(
      single({ type: "hitl", with: { mode: "form", message: "m", schema: { type: "object", properties: { a: { type: "any" } } } } }),
    );
    expect(diags).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "NODE_CONFIG_ERROR",
        path: "nodes.gate.with.schema",
        message: expect.stringContaining('type "any" is not JSON Schema'),
      }),
    );
  });

  it("fail the node when a rendered schema is invalid, instead of re-prompting", async () => {
    const g = await compileGraph(
      single(
        {
          type: "hitl",
          with: { mode: "form", message: "m", schema: { type: "object", properties: { pick: { enum: "{{ state.options }}" } } } },
        },
        { options: { type: "any", default: "not-a-list" }, out: { type: "object" } },
      ),
      {},
    );
    const r = await g.run({ threadId: "cs-render", onInterrupt: "fail" });
    expect(r.status).toBe("error");
    expect(r.error?.message).toContain('hitl node "gate" form: invalid schema:');
  });
});

describe("skill inputs", () => {
  it("are validated against their declared schema", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-skill-input-"));
    try {
      await fs.writeFile(
        path.join(dir, "SKILL.md"),
        "---\nname: s\nkind_of: executable\nhandler: ./handler.mjs\ninputs:\n  count:\n    type: integer\n    minimum: 1\n    required: true\n  tags:\n    type: array\n    items: { type: string }\n---\n",
      );
      await fs.writeFile(path.join(dir, "handler.mjs"), "export default (input) => ({ got: input });\n");
      const { skill } = await loadSkill(dir);
      const ctx = { emit: () => {}, workspace: dir, config: {} } as unknown as NodeRunContext;
      await expect(runSkill(skill!, { count: 2, tags: ["a"] }, ctx)).resolves.toEqual({ got: { count: 2, tags: ["a"] } });
      await expect(runSkill(skill!, { count: 1.5 }, ctx)).rejects.toThrow(
        'skill "s": input "count" does not match schema: / must be integer',
      );
      await expect(runSkill(skill!, { count: 1, tags: [3] }, ctx)).rejects.toThrow('input "tags" does not match schema: /0 must be string');
      await expect(runSkill(skill!, {}, ctx)).rejects.toThrow('required input "count" is missing');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
