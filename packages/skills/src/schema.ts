import { z } from "zod";
import { ContractSchemaSchema, DurationSchema, contractSchemaProblem, type PropertyDef } from "@flowgraph/spec";

// ---------------------------------------------------------------------------
// Skill front-matter schema
// ---------------------------------------------------------------------------

/**
 * Skill kinds the runner executes. `agent` and `composite` are reserved and rejected.
 */
export const SkillKindSchema = z.enum(["executable", "command"], {
  errorMap: (issue, ctx) =>
    issue.code === z.ZodIssueCode.invalid_enum_value
      ? {
          message:
            issue.received === "agent" || issue.received === "composite"
              ? `kindOf "${String(issue.received)}" is not supported; use "executable" or "command"`
              : `kindOf must be "executable" or "command"`,
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
    const problem = contractSchemaProblem(schema, { templates: true });
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

/** A single executable name. Paths and shell syntax are rejected. */
export const BIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

export const BinDeclSchema = z.object({
  name: z
    .string()
    .regex(
      BIN_NAME_PATTERN,
      "must be a single executable name (letters, digits, '.', '_', '+' or '-'), not a path or a shell command",
    ),
  optional: z.boolean().optional().default(false),
});

export const EnvDeclSchema = z.object({
  vars: z.array(EnvVarDeclSchema).optional(),
  bin: z.array(BinDeclSchema).optional(),
  node: z.string().optional(),
});

export const SkillFrontMatterSchema = z.object({
  apiVersion: z.literal("flowgraph/v1").optional(),
  kind: z.literal("Skill").optional(),
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  labels: z.record(z.string()).optional(),
  kindOf: SkillKindSchema.optional().default("executable"),
  inputs: z.record(SkillInputSchema).optional(),
  outputs: z.record(SkillOutputSchema).optional(),
  env: EnvDeclSchema.optional(),
  handler: z.string().optional(),
  command: z.array(z.string()).optional(),
  timeout: DurationSchema.optional(),
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
