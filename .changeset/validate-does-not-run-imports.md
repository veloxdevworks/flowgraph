---
"@flowgraph/skills": minor
"@flowgraph/core": minor
"@flowgraph/cli": minor
---

`flowgraph validate` no longer loads `imports` modules. Skill, agent and subgraph aliases are still read. A node type that is not already registered is an error, unless the graph declares a `nodes` import: then it is a warning, `PLUGIN_TYPE_UNRESOLVED`, including when the type name is a typo. A custom reducer is an error unless a `reducers` import is declared, in which case it is a warning, `UNREGISTERED_REDUCER`, until the graph runs. `--strict` treats those warnings as errors.

`SKILL.md` and `AGENT.md` front matter is parsed as YAML. A fence such as `---js`, or any other engine, is rejected and is not evaluated.

Skill preflight looks up `env.bin[].name` with `which` or `where` and no shell. The name must be a single executable name, not a path or a shell command.
