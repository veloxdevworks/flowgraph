/**
 * Built-in `ask_human` tool — lets intelligent agents ask clarifying questions.
 */

import { z } from "zod";
import { registerTool } from "./registry.js";
import type { NodeRunContext } from "../context.js";
import { interruptUntilValid } from "../runtime/resume-validation.js";

const askSchema = z.object({
  question: z.string(),
  choices: z.array(z.string()).optional(),
});

registerTool({
  name: "ask_human",
  description:
    "Ask the human operator a clarifying question and wait for their answer. " +
    "Use when the task is ambiguous or missing required information.",
  schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask the human" },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "Optional multiple-choice options",
      },
    },
    required: ["question"],
  },
  handler: async (args, ctx: NodeRunContext) => {
    const raw = (args ?? {}) as Record<string, unknown>;
    const question =
      typeof raw.question === "string"
        ? raw.question
        : typeof raw.prompt === "string"
          ? raw.prompt
          : "";
    const choices = Array.isArray(raw.choices) ? (raw.choices as string[]) : undefined;
    if (!question) {
      throw new Error('ask_human requires a "question" string argument.');
    }
    askSchema.parse({ question, choices });
    const hasChoices = Array.isArray(choices) && choices.length > 0;
    const answer = interruptUntilValid(ctx, {
      reason: question,
      kind: hasChoices ? "choice" : "question",
      data: { question, choices },
    }, resume => {
      const value = resume && typeof resume === "object" ? (resume as { choice?: unknown; answer?: unknown }).choice ?? (resume as { answer?: unknown }).answer : resume;
      if (hasChoices) {
        if (typeof value === "string" && choices.includes(value)) return value;
        const index = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
        if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1]!;
        throw new Error(`Choose one of: ${choices.join(", ")}, or a one-based index.`);
      }
      if ((typeof value === "string" && value.trim()) || typeof value === "number") return String(value);
      throw new Error("A non-empty answer is required.");
    }, {});
    return { answer };
  },
});
