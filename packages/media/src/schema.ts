import { z } from "zod";
import { BaseWithSchema } from "@flowgraph/spec";

/** Reference input(s): a template resolving to an Artifact, a file path, or a URL. */
const MediaInputRefSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const MediaCommonWithSchema = BaseWithSchema.extend({
  model: z.string().min(1).optional().describe("Media model override; top-level node model takes precedence"),
  prompt: z.string().optional(),
  negativePrompt: z.string().optional(),
  input: MediaInputRefSchema.optional().describe(
    "Reference input(s): a template resolving to an Artifact, a workspace path, or a URL",
  ),
  seed: z.number().int().optional(),
  variant: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "Templated cache-buster. Part of the job fingerprint but never sent to the vendor: change it (for example `{{ state.check.round }}`) to force a new job for an otherwise identical request. Unset, null or empty keeps the previous fingerprint.",
    ),
  params: z.record(z.unknown()).optional().describe("Vendor passthrough options"),
  timeout: z
    .any()
    .superRefine((_value, ctx) => {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "media with.timeout is not supported; set timeout on the node, or runtime.timeoutDefault as a graph default",
      });
    })
    .optional(),
});

export const ImageWithSchema = MediaCommonWithSchema.extend({
  prompt: z.string().min(1, "image: prompt is required"),
  count: z.number().int().min(1).max(10).optional().default(1),
  size: z.string().optional().describe('Pixel size such as "1024x1024"'),
  aspectRatio: z.string().optional().describe('Aspect ratio such as "16:9"'),
  quality: z.string().optional(),
});

export const VideoWithSchema = MediaCommonWithSchema.extend({
  count: z.number().int().min(1).max(4).optional().default(1),
  duration: z.number().positive().optional().describe("Clip length in seconds"),
  aspectRatio: z.string().optional(),
  resolution: z.string().optional().describe('e.g. "720p"'),
}).superRefine((v, ctx) => {
  if (!v.prompt?.trim() && v.input === undefined) {
    ctx.addIssue({ code: "custom", path: ["prompt"], message: "video: set prompt, input, or both" });
  }
});

export const Model3dFormatSchema = z.enum(["glb", "gltf", "fbx", "obj", "usdz", "stl", "3mf"]);

export const Model3dWithSchema = MediaCommonWithSchema.extend({
  mode: z
    .enum(["text", "image", "multiview"])
    .optional()
    .describe("Defaults from the inputs: no input = text, one = image, several = multiview"),
  format: Model3dFormatSchema.optional().default("glb"),
  texture: z.boolean().optional(),
  quality: z.string().optional(),
  count: z.number().int().min(1).max(4).optional().default(1),
}).superRefine((v, ctx) => {
  if (!v.prompt?.trim() && v.input === undefined) {
    ctx.addIssue({ code: "custom", path: ["prompt"], message: "model3d: set prompt, input, or both" });
  }
});

export const AudioKindSchema = z.enum(["speech", "sfx", "music"]);

export const AudioWithSchema = MediaCommonWithSchema.extend({
  kind: AudioKindSchema.describe(
    "speech = voice reading `text`; sfx = sound effect from `prompt`; music = song/score from `prompt` (and optional `text` lyrics)",
  ),
  text: z.string().optional().describe("speech: the script to speak; music: optional lyrics"),
  voice: z.string().optional().describe("speech: voice id or name (vendor-specific)"),
  language: z.string().optional().describe('e.g. "en"'),
  duration: z.number().positive().optional().describe("Target length in seconds (sfx, music)"),
  instrumental: z.boolean().optional().describe("music: no vocals"),
  format: z.enum(["mp3", "wav", "ogg", "flac", "opus"]).optional(),
  count: z.number().int().min(1).max(4).optional().default(1),
}).superRefine((v, ctx) => {
  if (v.kind === "speech" && !v.text?.trim()) {
    ctx.addIssue({ code: "custom", path: ["text"], message: "audio: kind speech requires text" });
  }
  if (v.kind === "sfx" && !v.prompt?.trim()) {
    ctx.addIssue({ code: "custom", path: ["prompt"], message: "audio: kind sfx requires prompt" });
  }
  if (v.kind === "music" && !v.prompt?.trim() && !v.text?.trim()) {
    ctx.addIssue({ code: "custom", path: ["prompt"], message: "audio: kind music requires prompt or text (lyrics)" });
  }
});

export const MediaProviderConfigSchema = z.object({
  kind: z.literal("media"),
  vendor: z.string().min(1),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});

export type ImageWith = z.infer<typeof ImageWithSchema>;
export type VideoWith = z.infer<typeof VideoWithSchema>;
export type Model3dWith = z.infer<typeof Model3dWithSchema>;
export type AudioWith = z.infer<typeof AudioWithSchema>;
export type MediaProviderConfig = z.infer<typeof MediaProviderConfigSchema>;
