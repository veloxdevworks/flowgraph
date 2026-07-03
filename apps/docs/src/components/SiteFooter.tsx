import { Link } from "react-router-dom";
import { GITHUB_REPO, ROUTES } from "../lib/docsLinks";

export default function SiteFooter() {
  return (
    <footer className="border-t border-border bg-card">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-10 md:flex-row">
        <div className="flex items-center gap-3">
          <span className="rounded border border-brand/40 bg-brand/10 px-2 py-0.5 font-mono text-xs text-brand">
            @velox
          </span>
          <span className="text-sm font-semibold tracking-tight text-foreground">flowgraph</span>
          <span className="text-sm text-muted-foreground">Declarative LangGraph orchestration</span>
        </div>
        <nav className="flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground">
          <Link to={ROUTES.docs} className="transition-colors hover:text-foreground">
            Docs
          </Link>
          <Link to={ROUTES.examples} className="transition-colors hover:text-foreground">
            Examples
          </Link>
          <a href={GITHUB_REPO} target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-foreground">
            GitHub ↗
          </a>
        </nav>
        <p className="text-xs text-muted-foreground">© {new Date().getFullYear()} Velox DevWorks</p>
      </div>
    </footer>
  );
}
