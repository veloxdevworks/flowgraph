/**
 * `flowgraph migrate` — migrates older specs toward the current `flowgraph/v1`
 * contract. Operates on raw YAML text (or comment-preserving YAML AST when
 * structural node rewrites are needed) so comments and formatting are kept.
 */

import { isAlias, isMap, isSeq, parseDocument, visit, type Document, type Node, type YAMLMap } from "yaml";
import { migrateDataContracts } from "./migrate-data-contracts.js";

export interface MigrateResult {
  changed: boolean;
  output: string;
  notes: string[];
  /** Rewrites that need a decision; the fields are left as they are. */
  manual: string[];
}

const CURRENT_API_VERSION = "flowgraph/v1";
const CANONICAL_KINDS: Record<string, string> = {
  graph: "Graph",
  skill: "Skill",
  subgraph: "Subgraph",
};

function cloneWithoutAnchors<T extends Node>(node: T): T {
  const cloned = node.clone() as T;
  visit(cloned, (_key, n) => {
    if (n && typeof n === "object" && "anchor" in n) {
      delete (n as { anchor?: string }).anchor;
    }
  });
  return cloned;
}

/**
 * When a YAML node carries an anchor that may be referenced by aliases elsewhere
 * in the document, materialize all alias uses into plain copies before mutating
 * the node so no alias is left dangling and untouched nodes never inherit edits.
 */
function detachAnchorForWrite(doc: Document, targetNode: YAMLMap): void {
  const anchor = targetNode.anchor;
  if (!anchor) return;

  visit(doc, {
    Alias(_key, alias) {
      if (alias.source === anchor) {
        return cloneWithoutAnchors(targetNode);
      }
    },
  });

  delete targetNode.anchor;
}

function resolveWithMapForWrite(doc: Document, nodeMap: YAMLMap, label: string): YAMLMap {
  const rawWith = nodeMap.get("with", true);
  if (isAlias(rawWith)) {
    const target = rawWith.resolve(doc);
    if (target === undefined) {
      throw new Error(`node "${label}": unresolved YAML alias "*${rawWith.source}" in with`);
    }
    const cloned = isMap(target) ? cloneWithoutAnchors(target) : (doc.createNode({}) as YAMLMap);
    nodeMap.set("with", cloned);
    return cloned;
  }
  if (isMap(rawWith)) {
    detachAnchorForWrite(doc, rawWith);
    return rawWith;
  }
  const created = doc.createNode({}) as YAMLMap;
  nodeMap.set("with", created);
  return created;
}

function resolveReadMap(doc: Document, value: unknown): YAMLMap | undefined {
  if (isAlias(value)) {
    const resolved = value.resolve(doc);
    return isMap(resolved) ? resolved : undefined;
  }
  return isMap(value) ? value : undefined;
}

function rewriteNode(
  doc: Document,
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
    const withMap = resolveWithMapForWrite(doc, nodeMap, label);
    nodeMap.set("type", "http");
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

  // Recurse into inline subgraph `spec:` (including `spec: *alias`)
  const inlineSpec = nodeMap.get("spec", true);
  if (isAlias(inlineSpec)) {
    const target = inlineSpec.resolve(doc);
    if (isMap(target) && containsWebhookContainer(doc, target)) {
      const cloned = cloneWithoutAnchors(target);
      nodeMap.set("spec", cloned);
      if (rewriteContainer(doc, cloned, notes, `${label}.spec`)) rewritten = true;
    }
  } else if (isMap(inlineSpec) && containsWebhookContainer(doc, inlineSpec)) {
    detachAnchorForWrite(doc, inlineSpec);
    if (rewriteContainer(doc, inlineSpec, notes, `${label}.spec`)) rewritten = true;
  }

  // Recurse into map body `with.node` and legacy inline `with.graph`
  const readWith = resolveReadMap(doc, nodeMap.get("with", true));
  if (readWith) {
    const mapBodyNode = readWith.get("node", true);
    if (isAlias(mapBodyNode)) {
      const target = mapBodyNode.resolve(doc);
      if (isMap(target) && containsWebhook(doc, target)) {
        const cloned = cloneWithoutAnchors(target);
        const writableWith = resolveWithMapForWrite(doc, nodeMap, label);
        writableWith.set("node", cloned);
        if (rewriteNode(doc, cloned, notes, `${label}.map`)) rewritten = true;
      }
    } else if (isMap(mapBodyNode) && containsWebhook(doc, mapBodyNode)) {
      const writableWith = resolveWithMapForWrite(doc, nodeMap, label);
      const writableBody = writableWith.get("node", true);
      if (isMap(writableBody)) {
        detachAnchorForWrite(doc, writableBody);
        if (rewriteNode(doc, writableBody, notes, `${label}.map`)) rewritten = true;
      }
    }

    const refreshedWith = resolveReadMap(doc, nodeMap.get("with", true));
    const inlineGraph = refreshedWith?.get("graph", true);
    if (isAlias(inlineGraph)) {
      const target = inlineGraph.resolve(doc);
      if (isMap(target) && containsWebhookContainer(doc, target)) {
        const cloned = cloneWithoutAnchors(target);
        const writableWith = resolveWithMapForWrite(doc, nodeMap, label);
        writableWith.set("graph", cloned);
        if (rewriteContainer(doc, cloned, notes, `${label}.graph`)) rewritten = true;
      }
    } else if (isMap(inlineGraph) && containsWebhookContainer(doc, inlineGraph)) {
      const writableWith = resolveWithMapForWrite(doc, nodeMap, label);
      const writableGraph = writableWith.get("graph", true);
      if (isMap(writableGraph)) {
        detachAnchorForWrite(doc, writableGraph);
        if (rewriteContainer(doc, writableGraph, notes, `${label}.graph`)) rewritten = true;
      }
    }
  }

  return rewritten;
}

function containsWebhookContainer(
  doc: Document,
  container: YAMLMap,
  visited = new Set<YAMLMap>(),
): boolean {
  if (visited.has(container)) return false;
  visited.add(container);
  const nodes = container.get("nodes", true);
  if (!isSeq(nodes)) return false;
  return nodes.items.some((n) => {
    const m = resolveReadMap(doc, n);
    return m !== undefined && containsWebhook(doc, m, visited);
  });
}

function containsWebhook(
  doc: Document,
  nodeMap: YAMLMap,
  visited = new Set<YAMLMap>(),
): boolean {
  if (visited.has(nodeMap)) return false;
  visited.add(nodeMap);
  if (nodeMap.get("type") === "webhook") return true;
  const spec = resolveReadMap(doc, nodeMap.get("spec", true));
  if (spec && containsWebhookContainer(doc, spec, visited)) return true;
  const withMap = resolveReadMap(doc, nodeMap.get("with", true));
  if (withMap) {
    const body = resolveReadMap(doc, withMap.get("node", true));
    if (body && containsWebhook(doc, body, visited)) return true;
    const inlineGraph = resolveReadMap(doc, withMap.get("graph", true));
    if (inlineGraph && containsWebhookContainer(doc, inlineGraph, visited)) return true;
  }
  return false;
}

function rewriteContainer(
  doc: Document,
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
  const doc = parseDocument(output);
  if (doc.errors.length === 0 && isMap(doc.contents)) {
    if (rewriteContainer(doc, doc.contents, notes)) {
      output = doc.toString();
    }
  }

  // 4. Data-contract migrations (channel items/properties, inputs, map item refs, etc.)
  const contracts = migrateDataContracts(output);
  output = contracts.output;
  notes.push(...contracts.notes);

  return { changed: output !== raw, output, notes, manual: contracts.manual };
}
