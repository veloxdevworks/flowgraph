---
"@flowgraph/skills": minor
"@flowgraph/core": minor
"@flowgraph/cli": minor
---

`flowgraph validate` no longer loads `imports` modules. Skill, agent and subgraph aliases are still read. A node type that only a `nodes` import would register is reported as `PLUGIN_TYPE_UNRESOLVED`, and a custom reducer from an import stays `UNREGISTERED_REDUCER` until the graph runs.

`SKILL.md` and `AGENT.md` front matter is parsed as YAML. A fence such as `---js`, or any other engine, is rejected and is not evaluated.

Skill preflight looks up `env.bin[].name` with `which` or `where` and no shell. The name must be a single executable name, not a path or a shell command.
