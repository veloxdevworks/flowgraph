---
"@flowgraph/spec": minor
"@flowgraph/core": minor
"@flowgraph/skills": minor
"@flowgraph/cli": patch
---

Every data contract uses one dialect, JSON Schema draft-07, checked by Ajv: hitl `form` and `review` schemas, wait `webhook.schema`, workshop output, agent output, skill `inputs` / `outputs`, and channel `items` / `properties`. Nested properties, `enum`, `items`, `additionalProperties`, numeric and string bounds, `format`, `oneOf` / `anyOf` / `allOf` and local `$ref`s are enforced at every depth. Values are never coerced, defaulted or stripped. Schemas are checked too: an unknown keyword or format, a malformed keyword, a non-local or unresolvable `$ref` or a non-draft-07 `$schema` is a validation error (`NODE_CONFIG_ERROR`, or `SKILL_SCHEMA_ERROR` for skills). A `{{ … }}` template in a value that affects validation is checked after rendering, while the rest of the schema, including annotations that contain templates, is checked at validation. An invalid rendered schema fails the node instead of re-prompting. Errors use one format everywhere (`<path> <problem>`, joined by `; `), the same as agent output.

hitl (`form` / `review`) and workshop nodes take `with.ui` for presentation hints (`order`, and per field `label`, `placeholder`, `help`, `widget`), passed to clients as `data.ui` and kept out of the schema. Skill `inputs` are validated against their schemas before the skill runs. `@flowgraph/spec` exports `contractErrors`, `contractSchemaProblem`, `compileContractSchema`, `ContractSchemaSchema`, `FormUiSchema` and `contractValidationAvailable`. `checkWorkshopOutput` returns `unverified: true` on hosts that forbid runtime code generation, leaving the schema check to the engine. Skill `kind_of: agent` and `composite` are rejected when the skill loads, since neither can run.

**What to change:**

- Answers, webhook payloads and workshop outputs that broke nested, `enum`, `items` or `additionalProperties` rules used to be accepted and are now rejected (re-prompted, or HTTP 422 for webhooks). Fix the sender or loosen the schema.
- Validation messages changed. `missing required field(s): a` is now `does not match schema: / must have required property 'a'`, and `field "a" expected type string` is now `does not match schema: /a must be string`. Update code that matched the old text.
- `type: any` is no longer accepted in a schema. Omit `type` to accept any value. Channel `type: any` is unchanged.
- A boolean `required` inside a schema (for example under `properties`) must become a list on the parent object: `required: [name]`. A skill input's own `required: true` stays as it is.
- `integer` is now available, and a skill input `type` must be a JSON Schema type. Free-form values such as `text` are rejected.
- Move presentation keys such as `placeholder` or `ui:widget` out of the schema into `with.ui`.
- A `$ref` must be local and resolve inside the same schema (`#/definitions/...`). Remote refs, including the draft-07 meta-schema URI, are rejected.
- Replace skills declared `kind_of: agent` with an `agent` node, and `composite` skills with a subgraph.
- With `allowPartial`, a workshop output that ended early may now leave out required fields at any depth, not only at the top level.
