import { registerFunction, type ReducerFn } from "@veloxdevworks/flowgraph-core";

registerFunction("tagAlpha", () => "alpha");
registerFunction("tagBeta", () => "beta");

registerFunction("findingA", () => ({ id: "a", v: 1 }));
registerFunction("findingB", () => ({ id: "b", v: 2 }));
registerFunction("findingAUpdate", () => ({ id: "a", v: 3 }));

const asItems = (v: unknown) => (Array.isArray(v) ? v : v != null ? [v] : []);

const uniqueById: ReducerFn = (cur, inc) => {
  const items = [
    ...(asItems(cur) as { id: string; v: number }[]),
    ...(asItems(inc) as { id: string; v: number }[]),
  ];
  const map = new Map(items.map((i) => [i.id, i]));
  return [...map.values()];
};

export default { uniqueById };
