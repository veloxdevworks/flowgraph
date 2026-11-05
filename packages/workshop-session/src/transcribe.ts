import type { WorkshopContract } from "./types.js";

export interface Transcriber {
  transcribe(
    audio: Blob | ArrayBuffer | Uint8Array,
    opts?: { mimeType?: string; language?: string; prompt?: string; signal?: AbortSignal },
  ): Promise<string>;
}

export type OpenAICompatibleTranscriberOptions = {
  apiKey: string;
  /** Required: the package does not pick a model. */
  model: string;
  /** Default https://api.openai.com/v1 */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

const EXT: Array<[RegExp, string]> = [
  [/wav|wave/, "wav"],
  [/webm/, "webm"],
  [/ogg|opus/, "ogg"],
  [/mp4|m4a|aac/, "m4a"],
  [/mpeg|mp3/, "mp3"],
  [/flac/, "flac"],
];

function fileNameFor(mime: string): string {
  const ext = EXT.find(([re]) => re.test(mime))?.[1] ?? "wav";
  return `audio.${ext}`;
}

/** Multipart POST to `${baseUrl}/audio/transcriptions` (OpenAI, xAI-style, and compatible servers). */
export function openAICompatibleTranscriber(opts: OpenAICompatibleTranscriberOptions): Transcriber {
  if (!opts.model) throw new Error("openAICompatibleTranscriber: 'model' is required");
  const base = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    async transcribe(audio, o = {}) {
      const f = opts.fetchImpl ?? fetch;
      const mime = o.mimeType ?? (audio instanceof Blob && audio.type ? audio.type : "audio/wav");
      const blob = audio instanceof Blob && audio.type === mime ? audio : new Blob([audio as BlobPart], { type: mime });
      const form = new FormData();
      form.append("file", blob, fileNameFor(mime));
      form.append("model", opts.model);
      if (o.language) form.append("language", o.language);
      if (o.prompt) form.append("prompt", o.prompt);
      const res = await f(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}` },
        body: form,
        ...(o.signal ? { signal: o.signal } : {}),
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new Error(`transcription failed (${res.status}): ${raw.split(opts.apiKey).join("[redacted]").slice(0, 500)}`);
      }
      try {
        const json = JSON.parse(raw) as { text?: unknown };
        return typeof json.text === "string" ? json.text.trim() : "";
      } catch {
        return raw.trim();
      }
    },
  };
}

/** Short vocabulary hint for the recognizer: agenda titles and top-level schema field names. */
export function transcriptionPrompt(contract: Pick<WorkshopContract, "agenda" | "schema">, maxChars = 400): string {
  const titles = contract.agenda.map((a) => a.title).filter(Boolean);
  const props = contract.schema?.["properties"];
  const fields = props && typeof props === "object" ? Object.keys(props) : [];
  const parts: string[] = [];
  if (titles.length) parts.push(`Topics: ${titles.join(", ")}.`);
  if (fields.length) parts.push(`Terms: ${fields.join(", ")}.`);
  const text = parts.join(" ");
  return text.length > maxChars ? text.slice(0, maxChars).replace(/[,\s]+\S*$/, "") : text;
}
