/**
 * `flowgraph migrate` — skeleton migrator that nudges older specs toward the
 * current `flowgraph/v1` contract. Operates on raw YAML text to preserve
 * comments and formatting; only well-understood, additive-safe rewrites are
 * applied. Extend with version-specific transforms as the contract evolves.
 */

export interface MigrateResult {
  changed: boolean;
  output: string;
  notes: string[];
}

const CURRENT_API_VERSION = "flowgraph/v1";
const CANONICAL_KINDS: Record<string, string> = {
  graph: "Graph",
  skill: "Skill",
  subgraph: "Subgraph",
};

export function migrateSpec(raw: string): MigrateResult {
  let output = raw;
  const notes: string[] = [];

  // 1. apiVersion → flowgraph/v1
  output = output.replace(
    /^(\s*apiVersion\s*:\s*)(['"]?)([^'"\n#]+?)(\2)(\s*(?:#.*)?)$/m,
    (match, prefix: string, _q: string, value: string, _q2: string, trailing: string) => {
      const trimmed = value.trim();
      if (trimmed === CURRENT_API_VERSION) return match;
      notes.push(`apiVersion: "${trimmed}" → "${CURRENT_API_VERSION}"`);
      return `${prefix}${CURRENT_API_VERSION}${trailing ?? ""}`;
    },
  );

  // 2. kind → canonical capitalization
  output = output.replace(
    /^(\s*kind\s*:\s*)(['"]?)([A-Za-z]+)(\2)(\s*(?:#.*)?)$/m,
    (match, prefix: string, _q: string, value: string, _q2: string, trailing: string) => {
      const canonical = CANONICAL_KINDS[value.toLowerCase()];
      if (!canonical || canonical === value) return match;
      notes.push(`kind: "${value}" → "${canonical}"`);
      return `${prefix}${canonical}${trailing ?? ""}`;
    },
  );

  return { changed: output !== raw, output, notes };
}
