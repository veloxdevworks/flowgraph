# skill-pack

A **reusable skill pack** — portable `SKILL.md` + handler modules that other graphs reference by path or package name.

## Contents

| Skill | Purpose |
|-------|---------|
| `skills/slugify` | Convert text to a URL-safe slug |
| `skills/word-count` | Count words and sentences |

These are the same skills used by [quickstart](../quickstart/quickstart.graph.yaml):

```yaml
nodes:
  - id: make-slug
    type: skill
    uses: ../skill-pack/skills/slugify
  - id: count
    type: skill
    uses: ../skill-pack/skills/word-count
```

## Skill contract pattern

Each skill directory contains:

```
skills/slugify/
├── SKILL.md      # Front-matter: name, inputs, outputs, env deps
└── handler.js    # ESM export invoked by the skill node
```

See [04 — Skills](../docs/04-skills.md) for the full `SKILL.md` format.

## Validate skills

```bash
flowgraph skills doctor skills/slugify skills/word-count
flowgraph skills list skills/
```

## Publishing (future)

The package is structured for npm publication (`files: ["skills"]`). When published, graphs can reference skills by package name via `imports` or `uses:` resolution.

## Tests

```bash
pnpm test
```

Runs contract validation against both skills without executing a full graph.

See [quickstart](../quickstart/) for the end-to-end graph that consumes this pack.
