import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import CodeBlock from "./CodeBlock";

export default function DocPage({ markdown }: { markdown: string }) {
  return (
    <article className="docs-prose max-w-none">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre({ children, ...rest }) {
            return <CodeBlock {...rest}>{children}</CodeBlock>;
          },
          a({ href, children, ...rest }) {
            if (href?.startsWith("./") || href?.startsWith("../")) {
              const gh = `https://github.com/veloxdevworks/flowgraph/blob/main/docs/${href.replace(/^\.\.\//, "").replace(/^\.\//, "")}`;
              return (
                <a href={gh} target="_blank" rel="noopener noreferrer" {...rest}>
                  {children}
                </a>
              );
            }
            return (
              <a href={href} {...rest}>
                {children}
              </a>
            );
          },
        }}
      >
        {markdown}
      </Markdown>
    </article>
  );
}
