import { useRef, useState, type ReactNode, type ComponentPropsWithoutRef } from "react";

const LANG_DISPLAY: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  yaml: "YAML",
  sh: "Shell",
  bash: "Shell",
};

function getLangDisplay(fenceLang: string | undefined): string | null {
  if (!fenceLang) return null;
  return LANG_DISPLAY[fenceLang] ?? fenceLang;
}

type Props = ComponentPropsWithoutRef<"pre"> & {
  children?: ReactNode;
};

export default function CodeBlock({ children, ...rest }: Props) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  let fenceLang: string | undefined;
  const child = Array.isArray(children) ? children[0] : children;
  if (child && typeof child === "object" && "props" in child) {
    const cn = (child as { props?: { className?: string } }).props?.className ?? "";
    const m = /language-(\w+)/.exec(cn);
    if (m) fenceLang = m[1];
  }

  function handleCopy() {
    if (!preRef.current) return;
    navigator.clipboard
      .writeText(preRef.current.innerText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{getLangDisplay(fenceLang) ?? ""}</span>
        <button type="button" onClick={handleCopy} className="code-block-copy" aria-label="Copy code">
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre ref={preRef} {...rest}>
        {children}
      </pre>
    </div>
  );
}
