# `@veloxdevworks/flowgraph-skills`

`SKILL.md` loader, contract validation, and environment preflight for flowgraph.

```bash
pnpm add @veloxdevworks/flowgraph-skills
```

```ts
import { loadSkill, preflightSkill } from "@veloxdevworks/flowgraph-skills";

const { skill } = await loadSkill("./skills/slugify");
const result = await preflightSkill(skill);
```

The CLI runs skill/agent preflight on `flowgraph run` and on `flowgraph validate --preflight`. See [04 — Skills](../../docs/04-skills.md).
