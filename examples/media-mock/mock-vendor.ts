/**
 * A media vendor plugin, as a third party would write one.
 *
 * It registers the vendor "mock-media" with @flowgraph/core. A graph then
 * declares `providers: { art: { kind: media, vendor: mock-media } }` and its
 * `image` / `model3d` nodes use it. Nothing here calls a network: it draws a
 * tiny PNG and writes a one-triangle GLB, so the whole pipeline (providers,
 * the job journal, artifacts, chaining) can be exercised offline.
 *
 * To write a real vendor, replace the bodies of start/poll/fetch with HTTP
 * calls, read the key with `ctx.secrets.get(apiKeyEnv)`, and persist results
 * with `ctx.saveOutput(...)`.
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import {
  registerMediaVendor,
  type JobHandle,
  type JobStatus,
  type MediaCallContext,
  type MediaRequest,
} from "@flowgraph/core";

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A solid-colour PNG whose colour comes from the prompt, so different prompts differ. */
export function solidPng(seed: string, size = 64): Uint8Array {
  const [r, g, b] = createHash("sha256").update(seed).digest();
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set([r!, g!, b!], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** A valid binary glTF (GLB) holding one triangle. */
export function triangleGlb(): Uint8Array {
  const bin = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteLength: 36, target: 34962 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
    }),
  );
  const jsonPadded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonPadded.length, 0);
  jh.write("JSON", 4, "ascii");
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.write("BIN\0", 4, "latin1");
  return Buffer.concat([header, jh, jsonPadded, bh, bin]);
}

// Job state lives with the vendor in real life; here, a per-process counter.
const polls = new Map<string, number>();

registerMediaVendor({
  vendor: "mock-media",
  modalities: ["image", "model3d"],
  create(opts) {
    return {
      name: opts.name,
      vendor: "mock-media",
      modalities: ["image", "model3d"],
      pollIntervalMs: 10,
      estimateCostUSD: (req) => (req.modality === "image" ? 0.01 * req.count : 0.25),

      async start(req: MediaRequest, ctx: MediaCallContext): Promise<JobHandle> {
        if (req.modality === "image") {
          // Synchronous vendor: save the outputs now and return them as `done`.
          const done = [];
          for (let i = 0; i < req.count; i++) {
            done.push(await ctx.saveOutput({ bytes: solidPng(`${req.prompt}#${i}`), mimeType: "image/png" }));
          }
          return { id: `img-${Date.now()}`, done };
        }
        // Asynchronous vendor: return a handle and let the engine poll.
        return { id: `m3d-${Date.now()}`, seed: req.prompt ?? req.inputs[0]?.identity ?? "model" };
      },

      async poll(handle: JobHandle): Promise<JobStatus> {
        const n = (polls.get(handle.id) ?? 0) + 1;
        polls.set(handle.id, n);
        return n < 3 ? { state: "running", progress: n * 40 } : { state: "done" };
      },

      async fetch(_handle: JobHandle, ctx: MediaCallContext) {
        return [await ctx.saveOutput({ bytes: triangleGlb(), mimeType: "model/gltf-binary" })];
      },
    };
  },
});

export default [];
