export type DocsNavItem = {
  to: string;
  label: string;
  end?: boolean;
};

export type DocsNavGroup = {
  title: string;
  items: DocsNavItem[];
};
