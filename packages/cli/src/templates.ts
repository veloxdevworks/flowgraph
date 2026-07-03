/**
 * Starter graph templates for `flowgraph new` / `flowgraph init`.
 */

const HEADER = "# yaml-language-server: $schema=https://veloxdevworks.com/flowgraph/schema/v1.json\n";

export interface ScaffoldFile {
  /** Relative to target dir, e.g. "skills/hello/handler.js" */
  path: string;
  content: string;
}

export interface ScaffoldResult {
  /** Relative path of the primary `<name>.graph.yaml` */
  graphFile: string;
  /** All files to write, including the graph file */
  files: ScaffoldFile[];
}

function singleFile(graphFile: string, content: string): ScaffoldResult {
  return { graphFile, files: [{ path: graphFile, content }] };
}

function hello(name: string): ScaffoldResult {
  const graphFile = `${name}.graph.yaml`;
  return {
    graphFile,
    files: [
      {
        path: graphFile,
        content: `${HEADER}apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: ${name}
  description: >
    Zero-code hello world — one skill node, no TypeScript registration required.

state:
  channels:
    name:
      type: string
      reducer: lastWrite
    message:
      type: string
      reducer: lastWrite

nodes:
  - id: greet
    type: skill
    uses: ./skills/hello
    input:
      name: "{{ state.name }}"
    with:
      output:
        map:
          message: "{{ result.message }}"

edges:
  - from: START
    to: greet
  - from: greet
    to: END

runtime:
  checkpoint:
    enabled: false
  observability:
    logs:
      level: info
      format: pretty
`,
      },
      {
        path: "skills/hello/SKILL.md",
        content: `---
apiVersion: flowgraph/v1
kind: Skill
name: hello
version: 0.1.0
description: >
  Greet someone by name — a minimal skill for flowgraph quickstarts.

kind_of: executable
handler: ./handler.js

inputs:
  name:
    type: string
    description: Name to greet (defaults to "World")
    required: false

outputs:
  message:
    type: string
    description: Greeting message

sideEffecting: false
timeout: 5s
---

## hello

Returns a friendly greeting for the given name.
`,
      },
      {
        path: "skills/hello/handler.js",
        content: `/**
 * hello handler — greet by name.
 *
 * @param {{ name?: string }} input
 * @returns {{ message: string }}
 */
export default function hello(input) {
  const name = String(input?.name ?? "World").trim() || "World";
  return { message: \`Hello, \${name}! Welcome to flowgraph.\` };
}
`,
      },
    ],
  };
}

function minimal(name: string): ScaffoldResult {
  const graphFile = `${name}.graph.yaml`;
  return singleFile(
    graphFile,
    `${HEADER}apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: ${name}
  description: A minimal flowgraph workflow.

state:
  channels:
    message:
      type: string
      reducer: lastWrite

nodes:
  - id: greet
    type: code
    with:
      fn: greet
      output:
        to: message

edges:
  - from: START
    to: greet
  - from: greet
    to: END

runtime:
  checkpoint:
    enabled: true
    backend: memory
`,
  );
}

function http(name: string): ScaffoldResult {
  const graphFile = `${name}.graph.yaml`;
  return singleFile(
    graphFile,
    `${HEADER}apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: ${name}
  description: Fetch a resource over HTTP and route on the result.

state:
  channels:
    response:
      type: object
      reducer: lastWrite

nodes:
  - id: fetch
    type: http
    with:
      method: GET
      url: "https://httpbin.org/json"
      expect:
        status: [200]
      output:
        to: response

  - id: classify
    type: router
    with:
      mode: rules
      routes:
        ok:
          when: "{{ state.response != null }}"
          to: END
        fail:
          default: true
          to: END

edges:
  - from: START
    to: fetch
  - from: fetch
    to: classify

runtime:
  checkpoint:
    enabled: true
    backend: memory
  retry:
    maxAttempts: 3
    backoff: exponential
`,
  );
}

function intelligent(name: string): ScaffoldResult {
  const graphFile = `${name}.graph.yaml`;
  return singleFile(
    graphFile,
    `${HEADER}apiVersion: flowgraph/v1
kind: Graph
metadata:
  name: ${name}
  description: An intelligent (LLM) node that can call tools.

# Requires OPENAI_API_KEY and: pnpm add @langchain/openai
providers:
  openai:
    kind: langchain
    vendor: openai
    model: gpt-4o

config:
  defaults:
    provider: openai

state:
  channels:
    answer:
      type: object
      reducer: lastWrite

nodes:
  - id: agent
    type: intelligent
    with:
      system: "You are a concise assistant."
      prompt: "{{ input.question }}"
      tools:
        - function: lookup
      schema:
        type: object
        properties:
          summary: { type: string }
        required: [summary]
      output:
        to: answer

edges:
  - from: START
    to: agent
  - from: agent
    to: END

runtime:
  checkpoint:
    enabled: true
    backend: memory
  budget:
    maxUSD: 1.00
    onExceed: warn
  hooks:
    - on: intelligent:beforeToolCall
      where: { tool: Bash }
      do: interrupt
      reason: "Approve shell command"
`,
  );
}

const TEMPLATES: Record<string, (name: string) => ScaffoldResult> = {
  hello,
  minimal,
  http,
  intelligent,
};

export function listTemplates(): string[] {
  return Object.keys(TEMPLATES);
}

export function templateFor(template: string, name: string): ScaffoldResult | undefined {
  return TEMPLATES[template]?.(name);
}
