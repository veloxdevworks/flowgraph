import { describe, it, expect } from "vitest";
import { RouterWithSchema } from "./index.js";

describe("model routers reject allMatches", () => {
  const routes = { a: { to: "left" }, b: { to: "right", default: true } };

  it("accepts mode: model with the default firstMatch", () => {
    expect(RouterWithSchema.safeParse({ mode: "model", routes }).success).toBe(true);
    expect(RouterWithSchema.safeParse({ mode: "model", match: "firstMatch", routes }).success).toBe(
      true,
    );
  });

  it("accepts mode: rules with allMatches", () => {
    expect(RouterWithSchema.safeParse({ mode: "rules", match: "allMatches", routes }).success).toBe(
      true,
    );
  });

  it("rejects mode: model with match: allMatches and names the restriction", () => {
    const r = RouterWithSchema.safeParse({ mode: "model", match: "allMatches", routes });
    expect(r.success).toBe(false);
    const issue = r.error?.issues.find((i) => i.path.join(".") === "match");
    expect(issue?.message).toContain("mode: model cannot use match: allMatches");
    expect(issue?.message).toContain("mode: rules");
  });
});
