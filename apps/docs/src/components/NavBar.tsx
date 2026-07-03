import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { GITHUB_REPO, ROUTES } from "../lib/docsLinks";

export default function NavBar() {
  const location = useLocation();
  const docsActive = location.pathname.startsWith("/docs");
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `text-sm font-medium transition-colors ${
      isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <header
      className={`sticky top-0 z-50 transition-all duration-300 ${
        scrolled
          ? "border-b border-border bg-background/90 backdrop-blur-md"
          : "border-b border-transparent bg-transparent"
      }`}
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <NavLink to={ROUTES.home} className="flex items-center gap-2 font-semibold tracking-tight text-foreground">
          <span className="rounded border border-brand/40 bg-brand/10 px-2 py-0.5 font-mono text-xs text-brand">
            @velox
          </span>
          <span>flowgraph</span>
        </NavLink>
        <nav className="flex flex-wrap items-center justify-end gap-4 sm:gap-6">
          <NavLink to={ROUTES.home} end className={linkClass}>
            Home
          </NavLink>
          <NavLink
            to={ROUTES.docs}
            className={() =>
              `text-sm font-medium transition-colors ${
                docsActive ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              }`
            }
          >
            Docs
          </NavLink>
          <NavLink to={ROUTES.examples} className={linkClass}>
            Examples
          </NavLink>
          <a
            href={`${ROUTES.schema}`}
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Schema
          </a>
          <a
            href={GITHUB_REPO}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            GitHub ↗
          </a>
        </nav>
      </div>
    </header>
  );
}
