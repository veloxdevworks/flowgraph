import { z } from "zod";
import { BaseWithSchema, DurationSchema } from "@flowgraph/spec";

const DemoHttpMethodSchema = z.union([
  z.literal("GET"),
  z.literal("POST"),
  z.literal("PUT"),
  z.literal("PATCH"),
  z.literal("DELETE"),
]);

const DemoExpectSchema = z
  .object({ status: z.array(z.number().int()).min(1) })
  .optional()
  .describe("HTTP statuses that count as success (default: any status below 400)");

export const DemoStatusSchema = z.enum(["passed", "failed", "inconclusive", "not_captured"]);

const DemoStepCheckSchema = z.union([
  z.object({ text: z.string().min(1).describe("This text is visible on the page") }).strict(),
  z.object({ visible: z.string().min(1).describe("An element matching this selector is visible") }).strict(),
  z.object({ url: z.string().min(1).describe("The page URL matches this glob") }).strict(),
  z.object({ hidden: z.string().min(1).describe("No element matching this selector is visible") }).strict(),
]);

export const DemoStepSchema = z.union([
  z.object({ goto: z.string().min(1) }).strict(),
  z.object({ click: z.string().min(1) }).strict(),
  z.object({ fill: z.object({ selector: z.string().min(1), value: z.string() }).strict() }).strict(),
  z.object({ press: z.string().min(1) }).strict(),
  z.object({ wait: z.string().min(1).describe("CSS selector or a duration") }).strict(),
  z.object({ screenshot: z.string().min(1).describe("Name of a screenshot to save") }).strict(),
  z.object({ expect: DemoStepCheckSchema }).strict(),
]);

export const DemoWithSchema = BaseWithSchema.extend({
  strict: z
    .boolean()
    .optional()
    .describe("Fail the node instead of returning ok:false on capture failure. With an `objective`, fail unless the status is passed"),
  label: z.string().optional().describe("Optional human-readable label for the artifact"),
  objective: z
    .string()
    .min(1)
    .optional()
    .describe("The claim this capture is evidence for. Only `steps` with a positive assertion can reach `passed`"),
  target: z
    .object({
      web: z
        .object({
          url: z.string().min(1).describe("Where the flow starts"),
          viewport: z
            .object({
              width: z.number().int().positive(),
              height: z.number().int().positive(),
            })
            .optional(),
          expect: DemoExpectSchema,
          timeout: DurationSchema.optional().describe("Limit for the whole flow (default 2m)"),
          stepTimeout: DurationSchema.optional().describe("Limit for each step (default 30s)"),
        })
        .strict(),
    })
    .strict()
    .optional()
    .describe("What `steps` run against"),
  steps: z
    .array(DemoStepSchema)
    .min(1)
    .optional()
    .describe("Scripted flow. Always recorded, and always ends with a screenshot"),
  expect: z
    .object({
      noConsoleErrors: z.boolean().optional().describe("No console error or uncaught page error during the flow"),
    })
    .strict()
    .optional()
    .describe("Checks over the whole `steps` flow"),
  http: z
    .object({
      method: DemoHttpMethodSchema.default("GET"),
      url: z.string(),
      headers: z.record(z.string()).optional(),
      body: z.unknown().optional(),
      expect: DemoExpectSchema,
      timeout: DurationSchema.optional().describe("Give up after this long (default 30s)"),
    })
    .optional(),
  screenshot: z
    .object({
      url: z.string(),
      waitFor: z
        .union([z.string(), DurationSchema])
        .optional()
        .describe("CSS selector or a duration to wait before capture"),
      video: z.boolean().optional(),
      expect: DemoExpectSchema,
      viewport: z
        .object({
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .optional(),
      timeout: DurationSchema.optional(),
    })
    .optional(),
  video: z
    .object({
      url: z.string(),
      duration: DurationSchema.optional().describe("How long to keep recording after `waitFor` (default 5s)"),
      expect: DemoExpectSchema,
      waitFor: z
        .union([z.string(), DurationSchema])
        .optional()
        .describe("CSS selector or a duration to wait before `duration` starts. The recording includes the page load and this wait"),
      viewport: z
        .object({
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .optional(),
      timeout: DurationSchema.optional(),
      scroll: z.boolean().optional().describe("Slow-scroll the page during recording"),
    })
    .optional(),
  simulator: z
    .object({
      platform: z.union([z.literal("ios"), z.literal("android")]),
      device: z.string().optional().describe("iOS: simulator name or UDID. Android: adb serial (e.g. emulator-5554) of a running device"),
      app: z.string().optional().describe("Bundle id / package to launch"),
      deepLink: z.string().optional(),
      capture: z.union([z.literal("video"), z.literal("screenshot")]).optional().default("video"),
      duration: DurationSchema.optional().describe("Recording length (default 10s)"),
      settle: DurationSchema.optional().describe(
        "Longest wait for the screen to change and hold still after a launch or deep link (default 30s)",
      ),
    })
    .optional(),
  file: z
    .object({
      path: z.string(),
    })
    .optional(),
}).superRefine((val, ctx) => {
  const modes = [val.http, val.screenshot, val.file, val.video, val.simulator, val.steps].filter((m) => m != null);
  if (val.steps && !val.target) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "demo: steps needs a target", path: ["target"] });
  }
  if (val.target && !val.steps) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "demo: target needs steps", path: ["steps"] });
  }
  if (val.expect && !val.steps) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "demo: expect needs steps", path: ["expect"] });
  }
  if (modes.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "demo: set exactly one of http, screenshot, file, video, simulator, or steps",
      path: [],
    });
  } else if (modes.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "demo: set only one of http, screenshot, file, video, simulator, or steps",
      path: [],
    });
  }
});

export type DemoStatus = z.infer<typeof DemoStatusSchema>;
export type DemoStep = z.infer<typeof DemoStepSchema>;
export type DemoWith = z.infer<typeof DemoWithSchema>;
