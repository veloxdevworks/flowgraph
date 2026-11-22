import { describe, expect, it } from "vitest";
import { DemoStatusSchema } from "./index.js";

describe("DemoStatusSchema", () => {
  it("names exactly the four outcomes of a demo", () => {
    expect(DemoStatusSchema.options).toEqual(["passed", "failed", "inconclusive", "not_captured"]);
    expect(DemoStatusSchema.safeParse("ok").success).toBe(false);
  });
});
