# Self-improvement loop — guardrails

These rules are loaded into every intelligent-node prompt. They constrain autonomous edits to this repository.

## Strategy / scope

- **Wrap LangGraph, don't fork it** ([docs/adr/0009-wrap-langgraph.md](../../docs/adr/0009-wrap-langgraph.md)): flowgraph is a low-code orchestration layer on LangGraph.js — no reimplementing checkpointing, interrupts, or the graph engine.
- **Hybrid authoring** ([docs/adr/0002-hybrid-authoring-model.md](../../docs/adr/0002-hybrid-authoring-model.md)): YAML declares topology and config; logic lives in registered functions, skills, or agent nodes — no imperative code embedded in YAML.
- **Small and reversible**: prefer diffs touching a handful of files. No new top-level `packages/*` or heavy dependencies in `core`. If an improvement needs a new package or major dependency, describe it in the PR body as a proposal for a human-authored ADR instead of building it.
- **Do not create or edit ADRs** — they are human-deliberated and immutable/superseded.
- **Every code change** ships with a matching test or doc update in the same PR.
- **Quiet no-op is valid**: if nothing safe and valuable stands out this cycle, return `proceed: false` with a clear reason. Do not manufacture busywork.

## Docs: improve them, but never leak the loop

- Docs improvements are a **first-class target**, equal to code.
- **Never** describe this automation, the `automation/` folder, the self-improvement loop, or any "autonomous agent that edits this repo" in **any** file under `docs/`. That tree feeds the public docs site pipeline.
- **Published docs** (render on veloxdevworks.com/flowgraph — prioritize these): `02-graph-spec`, `03-node-types`, `04-skills`, `07-runtime-and-execution`, `08-providers`, `09-cli`, `13-getting-started`, `14-programmatic-api`, `15-mcp-operations`, `IMPLEMENTATION_STATUS`. Other `docs/*` files are repo-only and do not change the site.
- **Edit in place**: a new `docs/NN-*.md` page does not publish without manual `flowgraph-app` wiring. Prefer improving existing published pages; propose new pages in the PR body.
- **`IMPLEMENTATION_STATUS.md` truthfulness**: never mark something "Shipped" without code + a passing test in the same or a prior merged PR.

## Protected paths (never edit)

- `automation/self-improve/**` — do not modify this loop's graph, guardrails, pause logic, budget, or attempt caps.
- `.github/workflows/**`, `LICENSE`, release/publish config, `package.json` `version` fields, `.changeset/`, and any `.env*` — human-only.
