import type { DocsNavGroup } from "./docsNavTypes";

export type { DocsNavItem, DocsNavGroup } from "./docsNavTypes";

export const DOCS_NAV_GROUPS: DocsNavGroup[] = [
  {
    title: "Guide",
    items: [
      { to: "/docs", label: "Getting started", end: true },
      { to: "/docs/cli", label: "CLI" },
      { to: "/docs/skills", label: "Skills" },
      { to: "/docs/mcp", label: "MCP integration" },
      { to: "/docs/examples", label: "Examples" },
    ],
  },
  {
    title: "Advanced",
    items: [
      { to: "/docs/programmatic-api", label: "Programmatic API" },
      { to: "/docs/hitl", label: "HITL & checkpointing" },
      { to: "/docs/providers", label: "Providers" },
    ],
  },
  {
    title: "Reference",
    items: [
      { to: "/docs/graph-spec", label: "Graph YAML schema" },
      { to: "/docs/node-types", label: "Node types" },
      { to: "/docs/implementation-status", label: "Implementation status" },
    ],
  },
];
