/**
 * `flowgraph migrate` — migrates older specs toward the current `flowgraph/v1`
 * contract. Operates on raw YAML text (or comment-preserving YAML AST when
 * structural node rewrites are needed) so comments and formatting are kept.
 */

import { isMap, isSeq, parseDocument, YAMLMap } from "yaml";

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

function rewriteWebhookNodes(doc: ReturnType<typeof parseDocument>, container: YAMLMap, notes: string[]): boolean {
  let rewritten = false;
  const nodes = container.get("nodes", true);
  if (!isSeq(nodes)) return false;

  for (const item of nodes.items) {
    if (!isMap(item)) continue;
    const typeVal = item.get("type");
    if (typeVal === "webhook") {
      const id = String(item.get("id") ?? "<unnamed>");
      item.set("type", "http");
      const rawWith = item.get("with", true);
      let withMap: YAMLMap;
      if (isMap(rawWith)) {
        withMap = rawWith;
      } else {
        withMap = doc.createNode({}) as YAMLMap;
        item.set("with", withMap);
      }
      const added: string[] = [];
      if (!withMap.has("method")) {
        withMap.set("method", "POST");
        added.push("method: POST");
      }
      if (!withMap.has("once")) {
        withMap.set("once", true);
        added.push("once: true");
      }
      notes.push(
        `node "${id}": type "webhook" → "http"${added.length ? ` (added ${added.join(", ")})` : ""}`,
      );
      rewritten = true;
    }

    // Recurse into inline subgraph definitions if present.
    const withMap = item.get("with", true);
    if (isMap(withMap)) {
      const inlineGraph = withMap.get("graph", true);
      if (isMap(inlineGraph)) {
        if (rewriteWebhookNodes(doc, inlineGraph, notes)) rewritten = true;
      }
    }
  }
  return rewritten;
}

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

  // 3. type: webhook → type: http with once: true (and method: POST if absent)
  try {
    const doc = parseDocument(output);
    if (doc.errors.length === 0 && isMap(doc.contents)) {
      if (rewriteWebhookNodes(doc, doc.contents, notes)) {
        output = doc.toString();
      }
    }
  } catch {
    // Leave unparseable YAML untouched; validator will report syntax errors.
  }

  return { changed: output !== raw, output, notes };
}
