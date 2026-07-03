import { GITHUB_REPO } from "../lib/docsLinks";

const EXAMPLES = [
  { name: "quickstart", desc: "Zero-code skill pipeline", env: "None" },
  { name: "triage-issue", desc: "code + router + skill (north-star)", env: "None" },
  { name: "release-notes", desc: "HITL interrupt + durable resume", env: "register.ts" },
  { name: "hitl", desc: "hitl node + interactive/CI resume", env: "None" },
  { name: "composition", desc: "map + subgraph fan-out", env: "register.ts" },
  { name: "mcp", desc: "MCP stdio mock, OAuth, agent tools", env: "Optional OAuth" },
  { name: "claude-agent", desc: "Claude SDK + builtin tools", env: "ANTHROPIC_API_KEY" },
  { name: "cursor-agent", desc: "Cursor SDK adapter", env: "CURSOR_API_KEY" },
  { name: "fs-agent", desc: "Sandboxed FS tools + hooks", env: "None" },
  { name: "reducers", desc: "Custom reducers + parallel fan-out", env: "register.ts" },
  { name: "skill-pack", desc: "Portable skill packaging", env: "None" },
];

export default function ExamplesPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="mb-2 text-3xl font-bold text-foreground">Examples</h1>
      <p className="mb-8 max-w-2xl text-muted-foreground">
        Runnable vertical slices in the monorepo. Clone the repo, run{" "}
        <code className="rounded border border-border bg-card px-1.5 py-0.5 text-sm">pnpm install && pnpm build</code>,
        then explore each example directory.
      </p>
      <div className="example-grid">
        {EXAMPLES.map((ex) => (
          <div key={ex.name} className="example-card">
            <h3>{ex.name}</h3>
            <p>{ex.desc}</p>
            <p className="text-xs text-muted-foreground">Setup: {ex.env}</p>
            <a
              href={`${GITHUB_REPO}/tree/main/examples/${ex.name}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-brand hover:underline"
            >
              View on GitHub ↗
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
