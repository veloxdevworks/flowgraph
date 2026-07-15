import { z } from "zod";

/**
 * Front-matter for a reusable agent definition (AGENT.md).
 * Prompt-only for v1 — the markdown body is the system prompt.
 */
export const AgentFrontMatterSchema = z.object({
  apiVersion: z.literal("flowgraph/v1").optional(),
  kind: z.literal("Agent").optional(),
  name: z.string().min(1),
  description: z.string().optional(),
});

export type AgentFrontMatter = z.infer<typeof AgentFrontMatterSchema>;

export interface AgentDef {
  path: string;
  frontMatter: AgentFrontMatter;
  /** Markdown body — used as the agent's system prompt. */
  body: string;
}
