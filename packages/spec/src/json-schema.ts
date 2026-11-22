import type { ZodTypeAny } from "zod";
import { ignoreOverride, zodToJsonSchema } from "zod-to-json-schema";
import {
  CoreProviderConfigSchema,
  GraphSpecObjectSchema,
  MapBodyNodeSchema,
  NodeSpecSchema,
  ProviderConfigSchema,
  isRelocatedFieldDef,
} from "./schema.js";

/** Where the v1 Graph JSON Schema is published. A breaking schema change gets a new path. */
export const GRAPH_JSON_SCHEMA_ID = "https://veloxdevworks.com/flowgraph/schema/v1.json";

const GRAPH_REF = "#/definitions/GraphSpec";
const NODE_REF = "#/definitions/NodeSpec";
const MAP_BODY_REF = "#/definitions/MapBodyNode";

/** Marks a relocated placeholder so it can be removed after generation. */
const RELOCATED = "x-flowgraph-relocated";

/**
 * Generate a JSON Schema document for the Graph spec.
 * Used for editor autocomplete/validation (e.g. yaml-language-server).
 *
 * Nodes, inline subgraph `spec` blocks and `map` bodies are recursive
 * definitions (`GraphSpec`, `NodeSpec`, `MapBodyNode`), so a nested graph is
 * checked like the top-level one. Per-type `with` blocks are not typed yet.
 */
export function generateJsonSchema(): Record<string, unknown> {
  const inlineSpec = (NodeSpecSchema.shape.spec as unknown as { _def: { innerType: ZodTypeAny } })._def.innerType;
  const strictGraph = GraphSpecObjectSchema.strict();
  const coreProviderJson = zodToJsonSchema(CoreProviderConfigSchema, { $refStrategy: "none", target: "jsonSchema7" });
  const schema = zodToJsonSchema(strictGraph, {
    name: "GraphSpec",
    $refStrategy: "none",
    definitions: { NodeSpec: NodeSpecSchema, MapBodyNode: MapBodyNodeSchema },
    override: (def, refs) => {
      if (isRelocatedFieldDef(def)) return { [RELOCATED]: true };
      if (def === ProviderConfigSchema._def) {
        const { $schema: _s, ...providerDef } = coreProviderJson as Record<string, unknown>;
        return providerDef;
      }
      if (def === inlineSpec._def) return { $ref: GRAPH_REF };
      const at = refs.currentPath.join("/");
      if (def === NodeSpecSchema._def && at !== NODE_REF) return { $ref: NODE_REF };
      if (def === MapBodyNodeSchema._def && at !== MAP_BODY_REF) return { $ref: MAP_BODY_REF };
      return ignoreOverride;
    },
  }) as Record<string, unknown>;
  const definitions = schema.definitions as Record<string, Record<string, unknown>>;
  for (const name of ["NodeSpec", "MapBodyNode"]) definitions[name]!.allOf = [mapBodyRule()];
  dropRelocated(schema);
  markBarrierFromUnique(schema);
  unicodeSafePatterns(schema);
  const { $schema, $ref, ...rest } = schema;
  // Draft-07 ignores every keyword beside a `$ref`, so the root reference sits in `allOf`.
  return {
    $schema,
    $id: GRAPH_JSON_SCHEMA_ID,
    title: "Flowgraph graph (flowgraph/v1)",
    allOf: [{ $ref }],
    ...rest,
  };
}

/** A `map` node's `with.node` is a map body, checked like any other node. */
function mapBodyRule(): Record<string, unknown> {
  return {
    if: { type: "object", properties: { type: { const: "map" } }, required: ["type"] },
    then: { type: "object", properties: { with: { type: "object", properties: { node: { $ref: MAP_BODY_REF } } } } },
  };
}

/**
 * Relocated settings (`runsOn.wait`, `http` `with.timeout`, `config.defaults.retry`, …)
 * are rejected by the Zod schema with a message naming the canonical field, but
 * would appear in the generated JSON Schema as `{}` and show up in editors.
 * Drop the properties so editors do not offer them.
 */
function dropRelocated(node: unknown): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) dropRelocated(item);
    return;
  }
  const rec = node as Record<string, unknown>;
  const props = rec.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const fields = props as Record<string, unknown>;
    for (const [key, value] of Object.entries(fields)) {
      if (!value || typeof value !== "object" || !(RELOCATED in value)) continue;
      delete fields[key];
      if (Array.isArray(rec.required)) rec.required = rec.required.filter((name) => name !== key);
    }
  }
  for (const value of Object.values(rec)) dropRelocated(value);
}

function compilesAsUnicode(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

/** Characters a unicode-mode regex allows after `\` as a literal. */
const UNICODE_IDENTITY_ESCAPES = new Set("^$\\.*+?()[]{}|/");

/**
 * The generator escapes every non-alphanumeric character of a literal
 * (`startsWith("route:")` becomes `^route\:`). JSON Schema validators and
 * editors compile patterns as unicode regexes, which reject `\:`, so keep
 * an escape only where it is meaningful.
 */
function unicodeSafePatterns(node: unknown): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) unicodeSafePatterns(item);
    return;
  }
  const rec = node as Record<string, unknown>;
  if (typeof rec.pattern === "string" && !compilesAsUnicode(rec.pattern)) {
    rec.pattern = rec.pattern.replace(/\\(.)/gs, (escape, char: string) =>
      UNICODE_IDENTITY_ESCAPES.has(char) || /[A-Za-z0-9]/.test(char) ? escape : char,
    );
  }
  for (const value of Object.values(rec)) unicodeSafePatterns(value);
}

/**
 * The list form of an edge `from` is a barrier. Zod records `minItems` but
 * not `uniqueItems`; editors should still reject repeated ids.
 */
function markBarrierFromUnique(node: unknown): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) markBarrierFromUnique(item);
    return;
  }
  const rec = node as Record<string, unknown>;
  const props = rec.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const from = (props as Record<string, unknown>).from;
    if (from) markFromArrayUnique(from);
  }
  for (const value of Object.values(rec)) markBarrierFromUnique(value);
}

function markFromArrayUnique(schema: unknown): void {
  if (schema == null || typeof schema !== "object") return;
  const rec = schema as Record<string, unknown>;
  if (rec.type === "array") {
    rec.uniqueItems = true;
    return;
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = rec[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) markFromArrayUnique(branch);
  }
}

/**
 * JSON Schema for one node type's `with` block (used by UIs to render a
 * generic inspector for plugin node types).
 */
export function zodToConfigJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as Record<
    string,
    unknown
  >;
}
