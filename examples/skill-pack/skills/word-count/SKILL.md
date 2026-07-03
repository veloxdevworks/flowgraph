---
apiVersion: flowgraph/v1
kind: Skill
name: word-count
version: 0.1.0
description: >
  Count words, characters, and sentences in a piece of text.

kind_of: executable
handler: ./handler.js

inputs:
  text:
    type: string
    description: The text to analyze
    required: true

outputs:
  words:
    type: number
    description: Number of words
  characters:
    type: number
    description: Number of characters
  sentences:
    type: number
    description: Number of sentences

sideEffecting: false
timeout: 5s
---

## word-count

Returns basic text statistics: word, character, and sentence counts.

### Usage in a graph

```yaml
- id: stats
  type: skill
  uses: word-count
  input:
    text: "{{ state.body }}"
  with:
    output: { to: stats }
```
