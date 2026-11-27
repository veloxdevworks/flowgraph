import { z } from "zod";
import { DurationSchema, keyedUnion, strictObject, strictWith } from "@flowgraph/spec";

export const ServiceReadySchema = keyedUnion(
  "ready",
  [
    strictObject({ port: z.union([z.number().int().positive(), z.string().min(1)]) }),
    strictObject({
      url: z.string(),
      status: z.array(z.number()).optional(),
    }),
    strictObject({ log: z.string() }).describe("Regex matched against combined stdout+stderr"),
  ],
  ["port", "url", "log"],
);

const START_ONLY_FIELDS = [
  "command",
  "args",
  "cwd",
  "env",
  "ready",
  "readyTimeout",
  "readyInterval",
  "stopSignal",
  "stopTimeout",
  "keepAlive",
] as const;

export const ServiceWithSchema = strictWith({
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
  if (action === "start" || action === "restart") {
    if (!val.command?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "service: command is required when action is start or restart",
        path: ["command"],
      });
    }
    return;
  }
  for (const field of START_ONLY_FIELDS) {
    if (val[field] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `service action: ${action} does not use ${field}; it only applies when a service is started or restarted`,
      });
    }
  }
});

export type ServiceWith = z.infer<typeof ServiceWithSchema>;
