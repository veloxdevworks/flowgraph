# ADR-0011 — MCP-first integrations

- **Status:** Accepted
- **Date:** 2026-06-26

## Context

flowgraph needs to integrate with external systems (Jira, Notion, Linear, GitHub, Salesforce, NetSuite, etc.). Hand-rolling per-vendor connector skills is O(N) maintenance, brittle across API changes, and does not provide OAuth-based authentication for non-technical users.

The Model Context Protocol (MCP) is an emerging standard with vendor-maintained servers, typed tool schemas, and (for remote servers) OAuth 2.1 authorization. flowgraph already reserved `{ mcp: string }` tool references in the intelligent-node schema but did not implement them.

## Decision

**MCP is the primary integration substrate.** Build one client layer (`@veloxdevworks/flowgraph-mcp`) and consume MCP in two modes:

1. **Deterministic** — a new `mcp` node type calls a specific tool or reads a resource with arguments mapped from state (no model in the loop).
2. **Agentic** — `{ mcp: <server> }` under an `intelligent` node's `tools` expands the server's tools and hands them to the provider; existing hooks (`intelligent:beforeToolCall`) gate side effects.

Graph specs declare servers in a top-level `mcpServers` block (familiar from Claude/Cursor). The CLI builds an `McpHub` from that config and injects it at compile time.

**Core stays dependency-light:** `McpHub` is an interface in `@veloxdevworks/flowgraph-core`; the `@modelcontextprotocol/sdk` dependency lives only in `@veloxdevworks/flowgraph-mcp`.

**Skills are retained** for the long tail (no MCP server), pure deterministic glue, and typed wrappers over coarse MCP tools.

**OAuth is phased:** M1 ships stdio + Streamable HTTP with header/env token auth. **M2 (shipped)** adds OAuth 2.1 browser consent, file-backed token store with refresh, dynamic client registration, and `auth: { type: oauth2 }` in `McpServerSchema`. CLI: `flowgraph mcp auth login|status|logout`.

## Consequences

- One integration investment unlocks many vendors simultaneously.
- flowgraph's value is durable, observable, human-gated orchestration over MCP tools — not owning connectors.
- Non-technical users need M2 OAuth for remote hosted servers; M1 targets dev/CI (stdio) and token-based HTTP.
- Security: MCP tool calls are side-effecting; hooks and `destructiveHint` annotations support approval flows.
- Must track MCP spec/SDK evolution and server quality variance.

## Alternatives considered

- **Per-vendor skill packs (`@veloxdevworks/flowgraph-skills-jira`, etc.):** rejected as primary strategy due to maintenance cost and no OAuth story.
- **MCP only for agents (no deterministic node):** rejected; deterministic orchestration is core to flowgraph's positioning.
- **MCP SDK in core:** rejected; violates minimal-deps-in-core (ADR-0006).
