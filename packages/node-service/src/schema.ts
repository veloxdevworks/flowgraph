import { z } from "zod";
import { BaseWithSchema, DurationSchema } from "@flowgraph/spec";

export const ServiceReadySchema = z.union([
  z.object({ port: z.union([z.number().int().positive(), z.string().min(1)]) }),
  z.object({
    url: z.string(),
    status: z.array(z.number()).optional(),
  }),
  z.object({ log: z.string() }).describe("Regex matched against combined stdout+stderr"),
]);

export const ServiceWithSchema = BaseWithSchema.extend({
  name: z.string().min(1).describe("Stable service id within a run/thread"),
  action: z
    .union([
      z.literal("start"),
      z.literal("stop"),
      z.literal("restart"),
      z.literal("status"),
    ])
    .optional()
    .default("start"),
  command: z.string().optional().describe("Required for start/restart"),
  args: z.array(z.string()).optional().describe("Argv; when set, runs without a shell"),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  ready: ServiceReadySchema.optional().describe("Readiness check before the node completes"),
  readyTimeout: DurationSchema.optional().describe("Default 30s"),
  readyInterval: DurationSchema.optional().describe("Default 300ms"),
  stopSignal: z.string().optional().describe("Default SIGTERM"),
  stopTimeout: DurationSchema.optional().describe("Default 5s before SIGKILL"),
  keepAlive: z
    .boolean()
    .optional()
    .describe("When true, skip auto-stop at run end regardless of runtime.services.terminateOnEnd"),
}).superRefine((val, ctx) => {
  const action = val.action ?? "start";
  if ((action === "start" || action === "restart") && !val.command?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "service: command is required when action is start or restart",
      path: ["command"],
    });
  }
});

export type ServiceWith = z.infer<typeof ServiceWithSchema>;
