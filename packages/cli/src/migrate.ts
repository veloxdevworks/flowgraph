/**
 * `flowgraph migrate` — migrates older specs toward the current `flowgraph/v1`
 * contract. Operates on raw YAML text (or comment-preserving YAML AST when
 * structural node rewrites are needed) so comments and formatting are kept.
 */

import { isAlias, isMap, isSeq, parseDocument, YAMLMap } from "yaml";

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

function resolveWithMapForWrite(
  doc: ReturnType<typeof parseDocument>,
  nodeMap: YAMLMap,
): YAMLMap {
  const rawWith = nodeMap.get("with", true);
  if (isAlias(rawWith)) {
    const target = rawWith.resolve(doc);
    const cloned = isMap(target) ? (target.clone() as YAMLMap) : (doc.createNode({}) as YAMLMap);
    delete cloned.anchor;
    nodeMap.set("with", cloned);
    return cloned;
  }
  if (isMap(rawWith)) {
    // If this `with:` map is itself an anchor referenced elsewhere, keep it
    // untouched for aliases? Wait: only clone when it has an anchor so aliases
    // elsewhere do not unexpectedly inherit `method: POST` / `once: true`.
    if (rawWith.anchor) {
      const cloned = rawWith.clone() as YAMLMap;
      delete cloned.anchor;
      nodeMap.set("with", cloned);
      return cloned;
    }
    return rawWith;
  }
  const created = doc.createNode({}) as YAMLMap;
  nodeMap.set("with", created);
  return created;
}

function resolveReadMap(doc: ReturnType<typeof parseDocument>, value: unknown): YAMLMap | undefined {
  if (isAlias(value)) {
    const resolved = value.resolve(doc);
    return isMap(resolved) ? resolved : undefined;
  }
  return isMap(value) ? value : undefined;
}

function rewriteNode(
  doc: ReturnType<typeof parseDocument>,
  nodeMap: YAMLMap,
  notes: string[],
  pathPrefix = "",
): boolean {
  let rewritten = false;
  const rawId = nodeMap.get("id");
  const id = rawId != null ? String(rawId) : "<unnamed>";
  const label = pathPrefix ? `${pathPrefix}.${id}` : id;

  const typeVal = nodeMap.get("type");
  if (typeVal === "webhook") {
    nodeMap.set("type", "http");
    const withMap = resolveWithMapForWrite(doc, nodeMap);
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
      `node "${label}": type "webhook" → "http"${added.length ? ` (added ${added.join(", ")})` : ""}`,
    );
    rewritten = true;
  }

  // Recurse into inline subgraph `spec:`
  const inlineSpec = nodeMap.get("spec", true);
  if (isMap(inlineSpec)) {
    if (rewriteContainer(doc, inlineSpec, notes, `${label}.spec`)) rewritten = true;
  }

  // Recurse into map body `with.node` and legacy inline `with.graph`
  const withMap = resolveReadMap(doc, nodeMap.get("with", true));
  if (withMap) {
    const mapBodyNode = withMap.get("node", true);
    if (isAlias(mapBodyNode)) {
      const target = mapBodyNode.resolve(doc);
      if (isMap(target) && containsWebhook(doc, target)) {
        const cloned = target.clone() as YAMLMap;
        delete cloned.anchor;
        const writableWith = resolveWithMapForWrite(doc, nodeMap);
        writableWith.set("node", cloned);
        if (rewriteNode(doc, cloned, notes, `${label}.map`)) rewritten = true;
      }
    } else if (isMap(mapBodyNode)) {
      if (rewriteNode(doc, mapBodyNode, notes, `${label}.map`)) rewritten = true;
    }

    const inlineGraph = withMap.get("graph", true);
    if (isMap(inlineGraph)) {
      if (rewriteContainer(doc, inlineGraph, notes, `${label}.graph`)) rewritten = true;
    }
  }

  return rewritten;
}

function containsWebhook(doc: ReturnType<typeof parseDocument>, nodeMap: YAMLMap): boolean {
  if (nodeMap.get("type") === "webhook") return true;
  const spec = nodeMap.get("spec", true);
  if (isMap(spec)) {
    const nodes = spec.get("nodes", true);
    if (isSeq(nodes) && nodes.items.some((n) => isMap(n) && containsWebhook(doc, n))) return true;
  }
  const withMap = resolveReadMap(doc, nodeMap.get("with", true));
  if (withMap) {
    const body = resolveReadMap(doc, withMap.get("node", true));
    if (body && containsWebhook(doc, body)) return true;
    const inlineGraph = withMap.get("graph", true);
    if (isMap(inlineGraph)) {
      const nodes = inlineGraph.get("nodes", true);
      if (isSeq(nodes) && nodes.items.some((n) => isMap(n) && containsWebhook(doc, n))) return true;
    }
  }
  return false;
}

function rewriteContainer(
  doc: ReturnType<typeof parseDocument>,
  container: YAMLMap,
  notes: string[],
  pathPrefix = "",
): boolean {
  let rewritten = false;
  const nodes = container.get("nodes", true);
  if (!isSeq(nodes)) return false;

  for (const item of nodes.items) {
    if (!isMap(item)) continue;
    if (rewriteNode(doc, item, notes, pathPrefix)) rewritten = true;
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
      if (rewriteContainer(doc, doc.contents, notes)) {
        output = doc.toString();
      }
    }
  } catch {
    // Leave unparseable YAML untouched; validator will report syntax errors.
  }

  return { changed: output !== raw, output, notes };
}
