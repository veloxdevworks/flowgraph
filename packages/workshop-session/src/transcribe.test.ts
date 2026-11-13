import { describe, expect, it } from "vitest";
import { openAICompatibleTranscriber, transcriptionPrompt } from "./transcribe.js";
import { concatFloat32, encodeWav, rmsLevel } from "./wav.js";
import { resampleToRate } from "./audio.js";

describe("openAICompatibleTranscriber", () => {
  it("posts multipart to /audio/transcriptions", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ text: " hello world " }), { status: 200 });
    }) as unknown as typeof fetch;
    const t = openAICompatibleTranscriber({ apiKey: "sk", model: "whisper-x", fetchImpl });
    const text = await t.transcribe(new Uint8Array([1, 2, 3]), { mimeType: "audio/webm", language: "en", prompt: "Topics: Scope." });
    expect(text).toBe("hello world");
    expect(seen!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((seen!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer sk");
    const form = seen!.init.body as FormData;
    expect(form.get("model")).toBe("whisper-x");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBe("Topics: Scope.");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.webm");
    expect(file.type).toBe("audio/webm");
    expect(file.size).toBe(3);
  });

  it("accepts Blobs and ArrayBuffers, defaults to wav, errors without the key", async () => {
    const bodies: FormData[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(init.body as FormData);
      return new Response("nope sk-key", { status: 500 });
    }) as unknown as typeof fetch;
    const t = openAICompatibleTranscriber({ apiKey: "sk-key", model: "m", baseUrl: "http://localhost:9/v1/", fetchImpl });
    const err = await t.transcribe(new Uint8Array([0]).buffer).catch((e: Error) => e);
    expect((bodies[0]!.get("file") as File).name).toBe("audio.wav");
    expect((err as Error).message).toContain("500");
    expect((err as Error).message).not.toContain("sk-key");
    await t.transcribe(new Blob([new Uint8Array(2)], { type: "audio/ogg" })).catch(() => undefined);
    expect((bodies[1]!.get("file") as File).name).toBe("audio.ogg");
    expect(() => openAICompatibleTranscriber({ apiKey: "k", model: "" })).toThrow();
  });
});

describe("transcriptionPrompt", () => {
  it("lists agenda titles and schema field names, capped", () => {
    const p = transcriptionPrompt({
      agenda: [{ id: "a", title: "Scope" }, { id: "b", title: "Rollout plan" }],
      schema: { properties: { acceptance: {}, owner: {} } },
    });
    expect(p).toBe("Topics: Scope, Rollout plan. Terms: acceptance, owner.");
    expect(transcriptionPrompt({ agenda: [] })).toBe("");
    expect(transcriptionPrompt({ agenda: [{ id: "a", title: "word ".repeat(200) }] }, 50).length).toBeLessThanOrEqual(50);
  });
});

describe("encodeWav", () => {
  it("writes a 44-byte mono PCM16 header", () => {
    const wav = encodeWav(new Int16Array([0, 1000, -1000]), 16_000);
    expect(wav.length).toBe(44 + 6);
    const v = new DataView(wav.buffer);
    const tag = (o: number) => String.fromCharCode(...wav.slice(o, o + 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint32(4, true)).toBe(36 + 6);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(28, true)).toBe(32_000);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(6);
    expect(v.getInt16(46, true)).toBe(1000);
    expect(v.getInt16(48, true)).toBe(-1000);
  });

  it("converts and clamps floats", () => {
    const v = new DataView(encodeWav(new Float32Array([1, -1, 2, 0]), 24_000).buffer);
    expect([44, 46, 48, 50].map((o) => v.getInt16(o, true))).toEqual([32767, -32768, 32767, 0]);
  });
});

describe("audio helpers", () => {
  it("rmsLevel, concat, resample", () => {
    expect(rmsLevel(new Float32Array(0))).toBe(0);
    expect(rmsLevel(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(concatFloat32([new Float32Array([1]), new Float32Array([2, 3])])).toEqual(new Float32Array([1, 2, 3]));
    expect(resampleToRate(new Float32Array(480), 48_000, 16_000).length).toBe(160);
  });
});
