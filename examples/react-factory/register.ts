import { registerFunction } from "@flowgraph/core";

/** Simulated repo scan: package.json dependencies → conventions. */
registerFunction("reactFactory.detectConventions", (input) => {
  const deps = ((input as { repo?: { dependencies?: string[] } }).repo?.dependencies ?? []) as string[];
  const has = (d: string) => deps.includes(d);
  return {
    css: has("tailwindcss") ? "tailwind" : has("styled-components") ? "styled-components" : "css-modules",
    tests: has("vitest") ? "vitest" : has("jest") ? "jest" : "none",
    routing: has("react-router") ? "react-router" : has("next") ? "next-app-router" : "none",
  };
});
