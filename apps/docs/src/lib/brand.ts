/**
 * flowgraph product brand tokens — magenta, distinct from sibling Velox products.
 *
 * @see apps/docs/src/index.css for CSS variables wired into Tailwind (`brand`, `brand-foreground`)
 */
export const PRODUCT_COLORS = {
  formulas: "#34d399",
  barcodes: "#a78bfa",
  remoteConsole: "#facc15",
  internationalization: "#22d3ee",
  flowgraph: "#e879f9",
} as const;

export const FLOWGRAPH_BRAND = PRODUCT_COLORS.flowgraph;
