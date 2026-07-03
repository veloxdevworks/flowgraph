import { Link } from "react-router-dom";
import { ROUTES } from "../lib/docsLinks";

export default function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <div className="max-w-2xl">
        <p className="mb-4 font-mono text-xs tracking-widest text-brand uppercase">LangGraph.js orchestration</p>
        <h1 className="mb-4 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          Define agentic workflows in YAML
        </h1>
        <p className="mb-8 text-lg leading-relaxed text-muted-foreground">
          flowgraph is a declarative orchestration layer on top of LangGraph.js. Author graphs in YAML, run them in CI
          or interactively, with skills, MCP tools, checkpointing, and human-in-the-loop built in.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            to={ROUTES.docs}
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
          <Link
            to={ROUTES.examples}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card"
          >
            Browse examples
          </Link>
        </div>
      </div>

      <div className="mt-16 grid gap-6 sm:grid-cols-3">
        {[
          { title: "YAML graphs", desc: "Topology, state, and config in one spec file" },
          { title: "Skills & MCP", desc: "Portable SKILL.md units and external tool servers" },
          { title: "Durable HITL", desc: "Checkpoint, interrupt, and resume across restarts" },
        ].map((f) => (
          <div key={f.title} className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-2 font-semibold text-foreground">{f.title}</h2>
            <p className="text-sm text-muted-foreground">{f.desc}</p>
          </div>
        ))}
      </div>

      <div className="code-block mt-12 max-w-2xl">
        <div className="code-block-header">
          <span className="code-block-lang">Shell</span>
        </div>
        <pre className="p-4 text-sm">
          <code>{`pnpm install && pnpm build
flowgraph run examples/quickstart/quickstart.graph.yaml --stream \\
  --input 'text=Hello, flowgraph World!'`}</code>
        </pre>
      </div>
    </div>
  );
}
