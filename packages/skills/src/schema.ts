import { z } from "zod";
import { PropertySchema } from "@veloxdevworks/flowgraph-spec";

// ---------------------------------------------------------------------------
// Skill front-matter schema
// ---------------------------------------------------------------------------

export const SkillKindSchema = z.union([
  z.literal("executable"),
  z.literal("command"),
  z.literal("agent"),
  z.literal("composite"),
]);

export const SkillInputSchema = z.object({
  type: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional().default(false),
  enum: z.array(z.unknown()).optional(),
  default: z.unknown().optional(),
  items: PropertySchema.optional(),
  properties: z.record(PropertySchema).optional(),
});

export const SkillOutputSchema = z.object({
  type: z.string().optional(),
  description: z.string().optional(),
  items: PropertySchema.optional(),
  properties: z.record(PropertySchema).optional(),
});

export const EnvVarDeclSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  secret: z.boolean().optional().default(false),
  optional: z.boolean().optional().default(false),
  example: z.string().optional(),
});

export const BinDeclSchema = z.object({
  name: z.string(),
  optional: z.boolean().optional().default(false),
  minVersion: z.string().optional(),
});

export const EnvDeclSchema = z.object({
  vars: z.array(EnvVarDeclSchema).optional(),
  bin: z.array(BinDeclSchema).optional(),
  network: z.boolean().optional(),
  node: z.string().optional(),
  packages: z.array(z.string()).optional(),
});

export const SkillFrontMatterSchema = z.object({
  apiVersion: z.literal("flowgraph/v1").optional(),
  kind: z.literal("Skill").optional(),
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  labels: z.record(z.string()).optional(),
  kind_of: SkillKindSchema.optional().default("executable"),
  inputs: z.record(SkillInputSchema).optional(),
  outputs: z.record(SkillOutputSchema).optional(),
  env: EnvDeclSchema.optional(),
  handler: z.string().optional(),
  command: z.array(z.string()).optional(),
  provider: z.string().optional(),
  timeout: z.string().optional(),
  sideEffecting: z.boolean().optional().default(false),
  permissions: z.array(z.string()).optional(),
});

export type SkillFrontMatter = z.infer<typeof SkillFrontMatterSchema>;
export type SkillKind = z.infer<typeof SkillKindSchema>;
export type EnvVarDecl = z.infer<typeof EnvVarDeclSchema>;
export type BinDecl = z.infer<typeof BinDeclSchema>;

// ---------------------------------------------------------------------------
// Loaded skill
// ---------------------------------------------------------------------------

export interface SkillDef {
  path: string;
  frontMatter: SkillFrontMatter;
  body: string;
  handlerPath?: string | undefined;
}
