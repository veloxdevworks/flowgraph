---
apiVersion: flowgraph/v1
kind: Skill
name: mock-create-ticket
version: 0.1.0
description: >
  Creates a ticket in a mock issue tracker. In production, swap the handler
  to target a real Jira/Linear/GitHub API.

kind_of: executable
handler: ./handler.js

inputs:
  project:
    type: string
    description: Project key (e.g. DEMO)
    required: true
  type:
    type: string
    description: Ticket type (bug | feature | question)
    required: true
    enum: [bug, feature, question]
  title:
    type: string
    description: Ticket title
    required: true
  description:
    type: string
    description: Optional longer description
    required: false

outputs:
  key:
    type: string
    description: Created ticket key (e.g. DEMO-42)
  url:
    type: string
    description: URL to the created ticket
  type:
    type: string
  title:
    type: string

env:
  vars:
    - name: TRACKER_URL
      description: Base URL of the issue tracker API
      optional: true
      example: "https://jira.example.com"
    - name: TRACKER_API_KEY
      description: API key for the issue tracker
      secret: true
      optional: true

sideEffecting: true
timeout: 10s
---

## mock-create-ticket

This skill creates a new ticket in the configured issue tracker.

### Usage in a graph

```yaml
- id: create-ticket
  type: skill
  uses: skills/mock-create-ticket
  input:
    project: "{{ config.vars.project }}"
    type:    "{{ state.label }}"
    title:   "{{ state.issue.title }}"
  with:
    output: { to: ticket }
```

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `TRACKER_URL` | No | API base URL (defaults to mock mode) |
| `TRACKER_API_KEY` | No | Auth token (omitted → mock mode) |

When `TRACKER_URL` is not set the skill runs in **mock mode** and returns
a synthetic ticket key without making any network call.
