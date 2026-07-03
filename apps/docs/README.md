# Docs site (`apps/docs`)

Public documentation for flowgraph, hosted at [veloxdevworks.com/flowgraph/](https://veloxdevworks.com/flowgraph/).

**Brand color:** magenta (`#e879f9`) — each Velox product uses its own accent (formulas mint, barcodes purple, remote-console yellow, i18n cyan).

## Stack

Vite 6 + React 19 + Tailwind 4 + react-markdown. Content is imported directly from the repo-root [`docs/`](../../docs/) folder (single source of truth).

## Develop locally

From the monorepo root:

```bash
pnpm install
pnpm build
pnpm --filter @velox/flowgraph-docs dev
```

Open http://localhost:5175/flowgraph/

## Build

```bash
pnpm --filter @velox/flowgraph-docs build
```

The `prebuild` script runs `flowgraph schema --out public/schema/v1.json` so the JSON Schema is served at `/flowgraph/schema/v1.json`.

## Deploy

On merge to `main`, CI builds `apps/docs/dist` and dispatches to `veloxdevworks/website`, which assembles the marketing shell + product doc trees and deploys to Cloudflare Pages.

See [veloxdevworks/website](https://github.com/veloxdevworks/website) for assembly details.
