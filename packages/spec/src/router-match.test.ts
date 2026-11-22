import { describe, it, expect } from "vitest";
import { RouterWithSchema } from "./index.js";

describe("model routers reject allMatches", () => {
  const routes = [{ name: "a", to: "left" }, { name: "b", to: "right", default: true }];
  const ruleRoutes = [
    { name: "a", when: "{{ true }}", to: "left" },
    { name: "b", default: true, to: "right" },
  ];

  it("accepts mode: model with the default firstMatch", () => {
    expect(RouterWithSchema.safeParse({ mode: "model", input: "route this", routes }).success).toBe(true);
    expect(RouterWithSchema.safeParse({ mode: "model", input: "route this", match: "firstMatch", routes }).success).toBe(
      true,
    );
  });

  it("accepts mode: rules with allMatches", () => {
    expect(RouterWithSchema.safeParse({ mode: "rules", match: "allMatches", routes: ruleRoutes }).success).toBe(
      true,
    );
  });

  it("rejects mode: model with match: allMatches and names the restriction", () => {
    const r = RouterWithSchema.safeParse({ mode: "model", input: "route this", match: "allMatches", routes });
    expect(r.success).toBe(false);
    const issue = r.error?.issues.find((i) => i.path.join(".") === "match");
    expect(issue?.message).toContain("mode: model cannot use match: allMatches");
    expect(issue?.message).toContain("mode: rules");
  });
});

describe("model routers route on explicit input", () => {
  const routes = [{ name: "a", to: "left" }, { name: "b", to: "right", default: true }];
  const ruleRoutes = [
    { name: "a", when: "{{ true }}", to: "left" },
    { name: "b", default: true, to: "right" },
  ];

  it.each([undefined, "", "   "])("rejects mode: model with input %j", (input) => {
    const r = RouterWithSchema.safeParse({ mode: "model", routes, ...(input === undefined ? {} : { input }) });
    expect(r.success).toBe(false);
    const issue = r.error?.issues.find((i) => i.path.join(".") === "input");
    expect(issue?.message).toContain("router mode: model requires input");
    expect(issue?.message).toContain("does not send the whole state");
  });

  it("does not require input for mode: rules", () => {
    expect(RouterWithSchema.safeParse({ mode: "rules", routes: ruleRoutes }).success).toBe(true);
  });
});
