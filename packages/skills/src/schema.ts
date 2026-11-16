import { z } from "zod";
import { ContractSchemaSchema, contractSchemaProblem, type PropertyDef } from "@flowgraph/spec";

// ---------------------------------------------------------------------------
// Skill front-matter schema
// ---------------------------------------------------------------------------

/**
 * Skill kinds that run today. `agent` and `composite` are reserved and rejected until the
 * runner supports them.
 */
export const SkillKindSchema = z.enum(["executable", "command"], {
  errorMap: (issue, ctx) =>
    issue.code === z.ZodIssueCode.invalid_enum_value
      ? {
          message:
            issue.received === "agent" || issue.received === "composite"
              ? `kind_of "${String(issue.received)}" is not supported yet; use "executable" or "command"`
              : `kind_of must be "executable" or "command"`,
        }
      : { message: ctx.defaultError },
});

/**
 * A named skill input: a JSON Schema (draft-07, the same dialect as every other data
 * contract) for its value. `required: true` / `false` is the input-level flag — whether
 * the caller must pass it (default false). A `required` list keeps its JSON Schema meaning:
 * the properties an object-typed input must have.
 */
export const SkillInputSchema = z
  .object({ required: z.union([z.boolean(), z.array(z.string())]).optional().default(false) })
  .passthrough()
  .superRefine((decl, ctx) => {
    const schema = skillInputValueSchema(decl as SkillInputDecl);
    if (JSON.stringify(schema).includes("{{")) return;
    const problem = contractSchemaProblem(schema);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid JSON Schema: ${problem}` });
  }) as unknown as z.ZodType<SkillInputDecl, z.ZodTypeDef, unknown>;

export type SkillInputDecl = {
  required: boolean | string[];
  type?: PropertyDef["type"];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  [keyword: string]: unknown;
};

/** Whether the caller must pass this input. */
export function isRequiredSkillInput(decl: SkillInputDecl): boolean {
  return decl.required === true;
}

/** The JSON Schema an input's value must satisfy (the declaration minus the input-level flag). */
export function skillInputValueSchema(decl: SkillInputDecl): Record<string, unknown> {
  const { required, ...schema } = decl;
  return Array.isArray(required) ? { ...schema, required } : schema;
}

/** A named skill output: a JSON Schema (draft-07) describing its value. */
export const SkillOutputSchema = ContractSchemaSchema;

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
