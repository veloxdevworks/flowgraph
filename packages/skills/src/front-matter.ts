import { parse } from "yaml";

/**
 * SKILL.md and AGENT.md front matter is YAML only.
 * A fence language such as `js` is rejected and never evaluated.
 */
export class YamlFrontMatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YamlFrontMatterError";
  }
}

const YAML_ENGINES = new Set(["", "yaml", "yml"]);

export function parseYamlFrontMatter(raw: string): { data: unknown; content: string } {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const text = withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.startsWith("---") || text.charAt(3) === "-") {
    return { data: {}, content: text };
  }

  let rest = text.slice(3);
  const newlineAt = rest.search(/\r?\n/);
  if (newlineAt === -1) {
    const language = rest.trim().toLowerCase();
    if (!YAML_ENGINES.has(language)) {
      throw new YamlFrontMatterError(
        `Front matter must be YAML. The "${rest.trim()}" engine is not allowed.`,
      );
    }
    throw new YamlFrontMatterError("Front matter must be YAML, closed by a --- line.");
  }

  const languageRaw = rest.slice(0, newlineAt);
  const language = languageRaw.trim().toLowerCase();
  if (!YAML_ENGINES.has(language)) {
    throw new YamlFrontMatterError(
      `Front matter must be YAML. The "${languageRaw.trim()}" engine is not allowed.`,
    );
  }
  if (language !== "") rest = rest.slice(languageRaw.length);

  const closeAt = rest.indexOf("\n---");
  if (closeAt === -1) {
    throw new YamlFrontMatterError("Front matter must be YAML, closed by a --- line.");
  }

  const matter = rest.slice(0, closeAt);
  let content = rest.slice(closeAt + "\n---".length);
  if (content.startsWith("\r")) content = content.slice(1);
  if (content.startsWith("\n")) content = content.slice(1);

  if (matter.replace(/^\s*#[^\n]+/gm, "").trim() === "") return { data: {}, content };

  let data: unknown;
  try {
    data = parse(matter, { schema: "yaml-1.1" });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new YamlFrontMatterError(`Front matter YAML is invalid: ${detail}`);
  }
  return { data: data ?? {}, content };
}
