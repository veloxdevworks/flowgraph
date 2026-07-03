import { useState } from "react";
import { NavLink } from "react-router-dom";
import { DOCS_NAV_GROUPS } from "../lib/docsNav";

function navLinkClass(isActive: boolean) {
  return [
    "block rounded-md border-l-2 py-1.5 pl-3 text-sm transition-colors",
    isActive
      ? "border-brand bg-brand/10 font-medium text-brand"
      : "border-transparent text-muted-foreground hover:border-border hover:bg-secondary/40 hover:text-foreground",
  ].join(" ");
}

export default function DocsSidebar() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="mb-4 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground"
          aria-expanded={open}
        >
          {open ? "Hide" : "Show"} documentation menu
        </button>
      </div>

      <aside
        className={[
          "lg:block",
          open ? "block" : "hidden",
          "lg:sticky lg:top-20 lg:self-start",
          "w-full shrink-0 lg:w-56 xl:w-64",
        ].join(" ")}
      >
        <nav className="space-y-6 pb-8" aria-label="Documentation">
          {DOCS_NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="mb-2 font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
                {group.title}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.to + item.label}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      onClick={() => setOpen(false)}
                      className={({ isActive }) => navLinkClass(isActive)}
                    >
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
