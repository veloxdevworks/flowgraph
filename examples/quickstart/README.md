# quickstart

The smallest end-to-end flowgraph you can run yourself — **no TypeScript, no
network, one command**.

It takes a string, turns it into a URL-safe slug, and computes word/sentence
stats. Both steps are `skill` nodes whose handlers live on disk
(`skills/slugify`, `skills/word-count`), so the CLI runs them directly without
any function registration.

## Run it

From this directory:

```bash
pnpm start
```

That runs:

```bash
flowgraph run quickstart.graph.yaml --stream --input 'text=Hello, flowgraph World!'
```

You'll see the event stream (`node.start`, `skill.start/end`, `state.update`,
`run.end`) and the final state with `slug`, `words`, and `sentences`.

Try your own input:

```bash
flowgraph run quickstart.graph.yaml --stream --input 'text=Release Notes for v2.0. Ship it!'
```

## Inspect / validate (also zero-code)

```bash
pnpm validate          # flowgraph validate quickstart.graph.yaml
pnpm graph             # ASCII topology
flowgraph graph quickstart.graph.yaml --format mermaid
```

## How it works

```
START → make-slug (skill: slugify) → count (skill: word-count) → END
```

- `make-slug` calls `skills/slugify` and maps `result.slug` → `state.slug`.
- `count` calls `skills/word-count` and maps `result.words` / `result.sentences`.

Because skill handlers are plain ESM modules loaded from disk, this graph needs
no `registerFunction` call — unlike `code` nodes, which require a JS runner
(see the `triage-issue` example for that pattern).
