import type { ReducerFn } from "@veloxdevworks/flowgraph-core";

const asItems = (v: unknown) => (Array.isArray(v) ? v : v != null ? [v] : []);

export const uniqueById: ReducerFn = (cur, inc) => {
  const items = [...asItems(cur), ...asItems(inc)] as { id: string }[];
  const map = new Map(items.map((i) => [i.id, i]));
  return [...map.values()];
};

export default { uniqueById };
