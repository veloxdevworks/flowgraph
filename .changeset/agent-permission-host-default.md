---
"@flowgraph/core": minor
---

The host sets the default tool permission for agent nodes. `compileGraph(spec, { runConfig: { permission } })` applies `auto`, `ask` or `deny` to every agent node that sets no `with.permission`, including agents in embedded subgraphs. Without a host value the default stays `auto`.

**What to change:** nothing for existing graphs. Hosts running graphs they do not fully trust can set `runConfig.permission` to `ask` or `deny`.
