import { describe, expect, it } from "vitest";
import { normalizeTools, type ToolWiring } from "./tools.js";

describe("normalizeTools node-as-tool meta", () => {
  it("attaches description and schema from resolveToolMeta", () => {
    const wiring: ToolWiring = {
      resolveToolMeta: (id) => {
        if (id !== "screenshot-tool") return undefined;
        return {
          description: "Capture a screenshot of a web page URL",
          schema: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        };
      },
      invokeNode: async () => ({ ok: true }),
    };

    const { normalized } = normalizeTools([{ node: "screenshot-tool" }], wiring);
    expect(normalized.specs).toHaveLength(1);
    expect(normalized.specs[0]).toMatchObject({
      name: "screenshot-tool",
      kind: "node",
      description: "Capture a screenshot of a web page URL",
      schema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    });
  });

  it("omits description/schema when resolveToolMeta returns nothing", () => {
    const { normalized } = normalizeTools([{ node: "bare" }], {});
    expect(normalized.specs[0]).toEqual({ name: "bare", kind: "node", ref: "bare" });
    expect(normalized.specs[0]?.description).toBeUndefined();
    expect(normalized.specs[0]?.schema).toBeUndefined();
  });
});
