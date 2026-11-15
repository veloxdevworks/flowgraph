---
"@flowgraph/core": patch
"@flowgraph/expr": minor
"@flowgraph/cli": patch
---

Warn when undeclared input keys would be discarded and reject unknown hook phases. Register the built-in mock when requested by CLI graphs. Implement duration, positional format and sandboxed map/filter/find expression-string callbacks for YAML.

Callback source must be a quoted literal and is included in static expression/policy checks. Imported mock adapters take precedence over the CLI fallback. Positional format placeholders such as {0} are now substituted. Unknown hook directives also fail validation.
