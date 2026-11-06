import { describe, expect, it } from "vitest";
import { HitlWithSchema, ImageWithSchema } from "./schema.js";

describe("gate artifact review schemas", () => {
  it("hitl accepts select none/one/many and rejects anything else", () => {
    for (const select of ["none", "one", "many"]) {
      expect(HitlWithSchema.safeParse({ message: "m", select }).success).toBe(true);
    }
    expect(HitlWithSchema.safeParse({ message: "m", select: "all" }).success).toBe(false);
    expect(HitlWithSchema.parse({ message: "m" }).select).toBeUndefined();
  });

  it("media accepts a string or number variant", () => {
    expect(ImageWithSchema.parse({ prompt: "p", variant: "{{ state.check.round }}" }).variant).toBe("{{ state.check.round }}");
    expect(ImageWithSchema.parse({ prompt: "p", variant: 2 }).variant).toBe(2);
    expect(ImageWithSchema.parse({ prompt: "p" }).variant).toBeUndefined();
  });
});
