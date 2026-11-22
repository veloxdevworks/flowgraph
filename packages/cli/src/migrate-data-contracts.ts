/**
 * Rewrites the fields the data contracts removed, on the YAML document so comments and
 * layout survive. Only rewrites with one correct result are applied; anything that needs a
 * decision is reported in `manual` and left as it is.
 */

import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";

export interface DataContractMigration {
  changed: boolean;
  output: string;
  notes: string[];
  manual: string[];
}

const INPUT_TYPES_WITH_NODE_INPUT = new Set(["function", "script", "shell"]);

export function migrateDataContracts(raw: string): DataContractMigration {
  const doc = parseDocument(raw);
  const none: DataContractMigration = { changed: false, output: raw, notes: [], manual: [] };
  if (doc.errors.length > 0 || !isMap(doc.contents)) return none;

  const notes: string[] = [];
  const manual: string[] = [];
  migrateGraph(doc, doc.contents, "", notes, manual);
  if (notes.length === 0) return { ...none, manual };
  return { changed: true, output: String(doc), notes, manual };
}

function get(map: YAMLMap, key: string): unknown {
  return map.get(key, true);
}

function mapAt(map: YAMLMap, key: string): YAMLMap | undefined {
  const value = get(map, key);
  return isMap(value) ? value : undefined;
}

function stringAt(map: YAMLMap, key: string): string | undefined {
  const value = get(map, key);
  return isScalar(value) && typeof value.value === "string" ? value.value : undefined;
}

function migrateGraph(doc: Document, graph: YAMLMap, where: string, notes: string[], manual: string[]): void {
  migrateChannels(doc, graph, where, notes);
  migrateInputFields(doc, graph, where, notes);
  migrateRootInput(doc, graph, where, notes);
  const nodes = get(graph, "nodes");
  if (!isSeq(nodes)) return;
  for (const item of nodes.items) {
    if (isMap(item)) migrateNode(doc, item, `${where}nodes.${stringAt(item, "id") ?? "?"}`, notes, manual);
  }
}

function migrateChannels(doc: Document, graph: YAMLMap, where: string, notes: string[]): void {
  const state = mapAt(graph, "state");
  const channels = state && mapAt(state, "channels");
  if (!channels) return;
  for (const pair of channels.items) {
    const channel = pair.value;
    if (!isMap(channel)) continue;
    const name = String(isScalar(pair.key) ? pair.key.value : pair.key);
    const hasItems = channel.has("items");
    const hasProperties = channel.has("properties");
    if (!hasItems && !hasProperties) continue;
    if (channel.has("schema")) continue;
    const schema = doc.createNode({}) as YAMLMap;
    if (hasItems) {
      schema.set("type", "array");
      schema.set("items", channel.get("items", true));
      channel.delete("items");
    }
    if (hasProperties) {
      if (!hasItems) schema.set("type", "object");
      schema.set("properties", channel.get("properties", true));
      channel.delete("properties");
    }
    channel.set("schema", schema);
    notes.push(`${where}state.channels.${name}: items/properties → schema`);
  }
}

function migrateInputFields(doc: Document, graph: YAMLMap, where: string, notes: string[]): void {
  const inputs = get(graph, "inputs");
  if (!isSeq(inputs)) return;
  for (const field of inputs.items) {
    if (!isMap(field)) continue;
    const key = stringAt(field, "key") ?? "?";
    const ui = (): YAMLMap => {
      let hints = mapAt(field, "ui");
      if (!hints) {
        hints = doc.createNode({}) as YAMLMap;
        field.set("ui", hints);
      }
      return hints;
    };
    if (field.has("label")) {
      const label = field.get("label", true);
      field.delete("label");
      if (!mapAt(field, "ui")?.has("label")) ui().set("label", label);
      notes.push(`${where}inputs.${key}: label → ui.label`);
    }
    if (stringAt(field, "type") === "text") {
      field.set("type", "string");
      if (!mapAt(field, "ui")?.has("widget")) ui().set("widget", "textarea");
      notes.push(`${where}inputs.${key}: type text → type string with ui.widget textarea`);
    }
  }
}

function inferInputType(value: unknown): string {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  return "json";
}

function migrateRootInput(doc: Document, graph: YAMLMap, where: string, notes: string[]): void {
  const input = mapAt(graph, "input");
  if (!input) return;
  let inputs = get(graph, "inputs");
  if (!isSeq(inputs)) {
    inputs = doc.createNode([]);
    graph.set("inputs", inputs);
  }
  const fields = (inputs as { items: unknown[] }).items;
  for (const pair of input.items) {
    const key = String(isScalar(pair.key) ? pair.key.value : pair.key);
    const existing = fields.find((f): f is YAMLMap => isMap(f) && stringAt(f, "key") === key);
    if (existing) {
      if (!existing.has("default")) existing.set("default", pair.value);
      continue;
    }
    const field = doc.createNode({ key }) as YAMLMap;
    const plain = isScalar(pair.value) ? pair.value.value : pair.value && typeof (pair.value as { toJSON?: unknown }).toJSON === "function" ? (pair.value as { toJSON: () => unknown }).toJSON() : undefined;
    field.set("type", inferInputType(plain));
    field.set("default", pair.value);
    fields.push(field);
  }
  graph.delete("input");
  notes.push(`${where}input → default on the matching inputs entries`);
}

function migrateNode(doc: Document, node: YAMLMap, label: string, notes: string[], manual: string[]): void {
  const type = stringAt(node, "type");
  const config = mapAt(node, "with");

  if (type && INPUT_TYPES_WITH_NODE_INPUT.has(type) && config?.has("input")) {
    if (node.has("input")) {
      manual.push(`${label}: has both input and with.input; merge them into the node's input by hand`);
    } else {
      node.set("input", config.get("input", true));
      config.delete("input");
      notes.push(`${label}: with.input → input`);
    }
  }

  if (type === "map" && config) migrateMap(doc, config, label, notes, manual);

  if (type === "subgraph" && config) {
    const stateMap = mapAt(config, "stateMap");
    if (stateMap?.has("out") && config.has("output")) {
      manual.push(`${label}: sets both stateMap.out and output; keep one`);
    }
  }

  const spec = mapAt(node, "spec");
  if (spec) migrateGraph(doc, spec, `${label}.spec.`, notes, manual);
}

function migrateMap(doc: Document, config: YAMLMap, label: string, notes: string[], manual: string[]): void {
  const as = stringAt(config, "as") ?? "item";
  const body = mapAt(config, "node");
  if (config.has("output")) {
    manual.push(`${label}: with.output is not supported on a map; use with.collect, or output on the node body`);
  }
  if (!body) return;
  let rewritten = 0;
  const visit = (value: unknown): void => {
    if (isScalar(value) && typeof value.value === "string") {
      const next = rewriteItemRefs(value.value, as);
      if (next !== value.value) {
        value.value = next;
        rewritten += 1;
      }
    } else if (isMap(value)) {
      for (const pair of value.items) {
        if (isScalar(pair.key) && pair.key.value === "spec") continue;
        visit(pair.value);
      }
    } else if (isSeq(value)) {
      value.items.forEach(visit);
    }
  };
  visit(body);
  if (rewritten > 0) notes.push(`${label}: {{ item.${as} }} → {{ ${as} }} (${rewritten} value${rewritten === 1 ? "" : "s"})`);
  migrateNode(doc, body, `${label}.with.node`, notes, manual);
}

/** Inside `{{ }}` only: `item.<as>` was how a map body read its item. */
export function rewriteItemRefs(text: string, as: string): string {
  if (!text.includes("{{")) return text;
  const escaped = as.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const member = new RegExp(`(?<![\\w$.])item\\.${escaped}(?![\\w$])`, "g");
  const index = new RegExp(`(?<![\\w$.])item\\[(["'])${escaped}\\1\\]`, "g");
  return text.replace(/\{\{[\s\S]*?\}\}/g, (block) => block.replace(member, as).replace(index, as));
}
