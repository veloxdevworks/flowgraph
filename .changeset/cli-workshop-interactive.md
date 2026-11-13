---
"@flowgraph/cli": minor
---

`--on-interrupt prompt` now runs an interactive workshop session for `workshop` interrupts on a terminal. Choose `chat` (a text facilitator, enabled with `FLOWGRAPH_WORKSHOP_MODEL=<vendor>:<model>` for `anthropic`, `openai` or `xai`), `form` (agenda plus each schema field, re-asking only fields the engine rejects), or `json` (the previous paste-JSON prompt). Without a TTY the prompt is unchanged. `@flowgraph/cli` now depends on `@flowgraph/workshop-session`.
