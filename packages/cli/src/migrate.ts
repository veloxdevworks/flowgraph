/**
 * `flowgraph migrate` — migrates older specs toward the current `flowgraph/v1`
 * contract. Operates on raw YAML text (or comment-preserving YAML AST when
 * structural node rewrites are needed) so comments and formatting are kept;
 * rewrites are idempotent so running twice produces no diff.
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
  subgraph: "Graph",
  skill: "Skill",
};

const NODE_TYPE_RENAMES: Record<string, string> = {
  code: "function",
  intelligent: "agent",
};

const HOOK_EVENT_RENAMES: Record<string, string> = {
  "intelligent:beforeToolCall": "agent:beforeToolCall",
  "intelligent:afterToolCall": "agent:afterToolCall",
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
    /^(\s*apiVersion\s*:\s*)(['"]?)([^'"\n#]+?)(\2)(\s*(?:#.*)?)$/gm,
    (match, prefix: string, _q: string, value: string, _q2: string, trailing: string) => {
      const trimmed = value.trim();
      if (trimmed === CURRENT_API_VERSION) return match;
      notes.push(`apiVersion: "${trimmed}" → "${CURRENT_API_VERSION}"`);
      return `${prefix}${CURRENT_API_VERSION}${trailing ?? ""}`;
    },
  );

  // 2. kind → Graph (canonical capitalization, and Subgraph → Graph)
  output = output.replace(
    /^(\s*kind\s*:\s*)(['"]?)([A-Za-z]+)(\2)(\s*(?:#.*)?)$/gm,
    (match, prefix: string, _q: string, value: string, _q2: string, trailing: string) => {
      const canonical = CANONICAL_KINDS[value.toLowerCase()];
      if (!canonical || canonical === value) return match;
      notes.push(`kind: "${value}" → "${canonical}"`);
      return `${prefix}${canonical}${trailing ?? ""}`;
    },
  );

  // 3. Pre-v1 node type aliases: code → function, intelligent → agent
  output = output.replace(
    /^(\s*(?:-\s*)?type\s*:\s*)(['"]?)(code|intelligent)(\2)(\s*(?:#.*)?)$/gm,
    (_match, prefix: string, q: string, value: string, q2: string, trailing: string) => {
      const next = NODE_TYPE_RENAMES[value]!;
      notes.push(`node type: "${value}" → "${next}"`);
      return `${prefix}${q}${next}${q2}${trailing ?? ""}`;
    },
  );
  output = output.replace(
    /(\btype\s*:\s*)(['"]?)(code|intelligent)(\2)(?=\s*[,}])/g,
    (_match, prefix: string, q: string, value: string, q2: string) => {
      const next = NODE_TYPE_RENAMES[value]!;
      notes.push(`node type: "${value}" → "${next}"`);
      return `${prefix}${q}${next}${q2}`;
    },
  );

  // 4. Pre-v1 hook events: intelligent:*ToolCall → agent:*ToolCall
  output = output.replace(
    /^(\s*(?:-\s*)?on\s*:\s*)(['"]?)(intelligent:(?:before|after)ToolCall)(\2)(\s*(?:#.*)?)$/gm,
    (_match, prefix: string, q: string, value: string, q2: string, trailing: string) => {
      const next = HOOK_EVENT_RENAMES[value]!;
      notes.push(`hook event: "${value}" → "${next}"`);
      return `${prefix}${q}${next}${q2}${trailing ?? ""}`;
    },
  );
  output = output.replace(
    /(\bon\s*:\s*)(['"]?)(intelligent:(?:before|after)ToolCall)(\2)(?=\s*[,}])/g,
    (_match, prefix: string, q: string, value: string, q2: string) => {
      const next = HOOK_EVENT_RENAMES[value]!;
      notes.push(`hook event: "${value}" → "${next}"`);
      return `${prefix}${q}${next}${q2}`;
    },
  );

  // 5. runtime.store → runtime.memory
  output = migrateRuntimeStore(output, notes);

  // 6. Skill front matter: kind_of → kindOf
  output = output.replace(
    /^(\s*)kind_of(\s*:)/gm,
    (_match, indent: string, colon: string) => {
      notes.push('skill front matter: "kind_of" → "kindOf"');
      return `${indent}kindOf${colon}`;
    },
  );

  // 7. type: webhook → type: http with once: true (and method: POST if absent)
  const doc = parseDocument(output);
  if (doc.errors.length === 0 && isMap(doc.contents)) {
    if (rewriteContainer(doc, doc.contents, notes)) {
      output = doc.toString();
    }
  }

  // 8. Data-contract and agent/router provider/model migrations
  const contracts = migrateDataContracts(output);
  output = contracts.output;
  notes.push(...contracts.notes);

  return { changed: output !== raw, output, notes, manual: contracts.manual };
}

function migrateRuntimeStore(raw: string, notes: string[]): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let inRuntime = false;
  let runtimeIndent = -1;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (trimmed && !trimmed.startsWith("#")) {
      if (indent === 0) {
        inRuntime = /^runtime\s*:/.test(trimmed);
        runtimeIndent = inRuntime ? 0 : -1;
      } else if (inRuntime && indent <= runtimeIndent) {
        inRuntime = false;
      }
    }

    if (inRuntime && indent > runtimeIndent) {
      const flowMatch = /^(\s*)store\s*:\s*\{([^}]*)\}(\s*(?:#.*)?)$/.exec(line);
      if (flowMatch) {
        const [, storeIndent, inner, trailing] = flowMatch;
        const disabled = /\benabled\s*:\s*false\b/.test(inner!) || /\bbackend\s*:\s*['"]?none['"]?\b/.test(inner!);
        if (disabled) {
          notes.push("runtime.store (disabled/none) removed");
        } else {
          const backendMatch = /\bbackend\s*:\s*['"]?([a-zA-Z0-9_-]+)['"]?/.exec(inner!);
          const rawBackend = backendMatch?.[1] ?? "memory";
          const nextBackend = rawBackend === "sqlite" || rawBackend === "postgres" ? "checkpoint" : "memory";
          notes.push(`runtime.store (backend: ${rawBackend}) → runtime.memory (backend: ${nextBackend})`);
          out.push(`${storeIndent}memory: { backend: ${nextBackend} }${trailing ?? ""}`);
        }
        i += 1;
        continue;
      }

      const blockMatch = /^(\s*)store\s*:(\s*(?:#.*)?)$/.exec(line);
      if (blockMatch) {
        const storeIndent = blockMatch[1]!;
        const trailing = blockMatch[2] ?? "";
        const blockLines: string[] = [];
        let j = i + 1;
        while (j < lines.length) {
          const nextLine = lines[j]!;
          const nextTrimmed = nextLine.trim();
          const nextIndent = nextLine.length - nextLine.trimStart().length;
          if (nextTrimmed && !nextTrimmed.startsWith("#") && nextIndent <= storeIndent.length) break;
          blockLines.push(nextLine);
          j += 1;
        }
        let enabled = true;
        let rawBackend = "memory";
        const keptLines: string[] = [];
        for (const bl of blockLines) {
          const enMatch = /^\s*enabled\s*:\s*(true|false)\b/.exec(bl);
          if (enMatch) {
            enabled = enMatch[1] === "true";
            continue;
          }
          const bMatch = /^(\s*backend\s*:\s*)(['"]?)([a-zA-Z0-9_-]+)(\2)(\s*(?:#.*)?)$/.exec(bl);
          if (bMatch) {
            rawBackend = bMatch[3]!;
            const nextBackend =
              rawBackend === "sqlite" || rawBackend === "postgres" ? "checkpoint" : rawBackend;
            keptLines.push(`${bMatch[1]}${bMatch[2]}${nextBackend}${bMatch[4]}${bMatch[5] ?? ""}`);
            continue;
          }
          keptLines.push(bl);
        }
        if (!enabled || rawBackend === "none") {
          notes.push("runtime.store (disabled/none) removed");
        } else {
          const nextBackend =
            rawBackend === "sqlite" || rawBackend === "postgres" ? "checkpoint" : rawBackend;
          notes.push(`runtime.store (backend: ${rawBackend}) → runtime.memory (backend: ${nextBackend})`);
          out.push(`${storeIndent}memory:${trailing}`);
          const hasBackendLine = keptLines.some((l) => /^\s*backend\s*:/.test(l));
          if (!hasBackendLine) {
            out.push(`${storeIndent}  backend: ${nextBackend}`);
          }
          out.push(...keptLines);
        }
        i = j;
        continue;
      }
    }

    out.push(line);
    i += 1;
  }

  return out.join("\n");
}
