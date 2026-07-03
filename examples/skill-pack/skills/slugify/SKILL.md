---
apiVersion: flowgraph/v1
kind: Skill
name: slugify
version: 0.1.0
description: >
  Convert a piece of text (e.g. a title) into a URL-safe slug.

kind_of: executable
handler: ./handler.js

inputs:
  text:
    type: string
    description: The text to slugify
    required: true
  maxLength:
    type: number
    description: Optional maximum slug length
    required: false

outputs:
  slug:
    type: string
    description: The URL-safe slug

sideEffecting: false
timeout: 5s
---

## slugify

Converts arbitrary text into a lowercase, hyphenated, URL-safe slug.

### Usage in a graph

```yaml
- id: make-slug
  type: skill
  uses: slugify
  input:
    text: "{{ state.title }}"
  with:
    output: { to: slug }
```
