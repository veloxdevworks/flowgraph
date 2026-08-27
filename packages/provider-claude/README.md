# `@veloxdevworks/flowgraph-provider-claude`

Claude Agent SDK adapter for flowgraph intelligent / agent nodes.

```bash
pnpm add @veloxdevworks/flowgraph-provider-claude @anthropic-ai/claude-agent-sdk
```

```ts
import { compileGraph } from "@veloxdevworks/flowgraph-core";
import { createClaudeProviderFromConfig } from "@veloxdevworks/flowgraph-provider-claude";

const claude = await createClaudeProviderFromConfig("claude", { kind: "claude" }, { cwd });
const compiled = await compileGraph(spec, { providers: [claude] });
```

The CLI lazy-loads this package when a graph declares `providers.*.kind: claude`. Requires `ANTHROPIC_API_KEY` (or a local Claude CLI fallback). See [08 — Providers](../../docs/08-providers.md).
