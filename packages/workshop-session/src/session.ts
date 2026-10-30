import { FACILITATOR_TOOLS, type FacilitatorToolCall } from "./tools.js";
import { voiceProvider } from "./providers.js";
import type { MintedVoiceToken, WorkshopContract, WorkshopTranscriptTurn } from "./types.js";

export type WorkshopSessionEvents = {
  onTranscript?: (turn: WorkshopTranscriptTurn) => void;
  onAssistantText?: (delta: string) => void;
  onAudioDelta?: (pcm24k: ArrayBuffer) => void;
  onSpeechStarted?: () => void;
  onToolCall?: (call: FacilitatorToolCall) => Promise<unknown> | unknown;
  onError?: (err: Error) => void;
  onExpired?: () => void;
  onOpen?: () => void;
  onClose?: () => void;
};

function browserWebSocket(url: string, token: string, providerId: string): WebSocket {
  if (providerId === "xai") {
    return new WebSocket(url, [`xai-client-secret.${token}`]);
  }
  return new WebSocket(url, [`openai-insecure-api-key.${token}`, "realtime"]);
}

export class WorkshopSession {
  private ws: WebSocket | null = null;
  private closed = false;

  constructor(
    private readonly token: MintedVoiceToken,
    private readonly contract: WorkshopContract,
    private readonly events: WorkshopSessionEvents = {},
    private readonly connect: typeof browserWebSocket = browserWebSocket,
  ) {}

  get provider() {
    return voiceProvider(this.token.provider);
  }

  async start(
    opts: { instructions?: string; voice?: string; seedTranscript?: string; vad?: boolean } = {},
  ): Promise<void> {
    const voice = opts.voice ?? this.contract.voice?.voice ?? this.provider.defaultVoice;
    const instructions = opts.instructions ?? this.buildInstructions(opts.seedTranscript);
    const vad = opts.vad !== false;
    this.ws = this.connect(this.token.url, this.token.token, this.token.provider);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      this.events.onOpen?.();
      this.send({
        type: "session.update",
        session: {
          voice,
          instructions,
          turn_detection: vad ? { type: "server_vad", silence_duration_ms: 600 } : null,
          input_audio_transcription: { model: "whisper-1" },
          tools: FACILITATOR_TOOLS,
        },
      });
    });
    this.ws.addEventListener("message", (ev) => {
      void this.handleMessage(ev.data);
    });
    this.ws.addEventListener("error", () => {
      this.events.onError?.(new Error("Workshop voice socket error"));
    });
    this.ws.addEventListener("close", () => {
      this.events.onClose?.();
      if (!this.closed) this.events.onExpired?.();
    });
  }

  sendAudioPcm16(base64: string): void {
    this.send({ type: "input_audio_buffer.append", audio: base64 });
  }

  commitAudio(): void {
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
  }

  sendText(text: string): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.send({ type: "response.create" });
  }

  interruptPlayback(): void {
    this.send({ type: "response.cancel" });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  buildInstructions(seedTranscript?: string): string {
    const agenda = this.contract.agenda
      .map((a) => `- ${a.id}: ${a.title}${a.description ? ` — ${a.description}` : ""}`)
      .join("\n");
    const schema = this.contract.schema ? JSON.stringify(this.contract.schema) : "{}";
    const context =
      typeof this.contract.context === "string"
        ? this.contract.context
        : this.contract.context
          ? JSON.stringify(this.contract.context)
          : "";
    const seed = seedTranscript ? `\nPrior transcript (continue this meeting):\n${seedTranscript}\n` : "";
    return [
      this.contract.facilitator ?? "You facilitate a workshop. Cover the agenda. Do not invent requirements.",
      "Call update_draft as facts land. Call cover_agenda_item when a topic is done. Call finish when the schema is satisfied or the human ends the session.",
      `Agenda:\n${agenda || "(none)"}`,
      `Output JSON Schema:\n${schema}`,
      context ? `Primed context:\n${context}` : "",
      seed,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "string") return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(event["type"] ?? "");
    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      const delta = event["delta"];
      if (typeof delta === "string") {
        this.events.onAudioDelta?.(base64ToBuffer(delta));
      }
      return;
    }
    if (type === "response.output_text.delta" || type === "response.text.delta" || type === "response.audio_transcript.delta") {
      const delta = event["delta"];
      if (typeof delta === "string") this.events.onAssistantText?.(delta);
      return;
    }
    if (
      type === "response.audio_transcript.done" ||
      type === "response.output_audio_transcript.done"
    ) {
      const transcript = String(event["transcript"] ?? event["text"] ?? "");
      if (transcript) {
        this.events.onTranscript?.({ role: "assistant", text: transcript, at: new Date().toISOString() });
      }
      return;
    }
    if (type === "session.expired") {
      this.events.onExpired?.();
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      this.events.onSpeechStarted?.();
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = String(event["transcript"] ?? "");
      if (transcript) {
        this.events.onTranscript?.({ role: "user", text: transcript, at: new Date().toISOString() });
      }
      return;
    }
    if (type === "response.function_call_arguments.done") {
      const name = String(event["name"] ?? "");
      const callId = String(event["call_id"] ?? event["item_id"] ?? "");
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(String(event["arguments"] ?? "{}")) as Record<string, unknown>;
      } catch {
        args = {};
      }
      const result = await this.events.onToolCall?.({ name, callId, args });
      this.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(result ?? { ok: true }),
        },
      });
      this.send({ type: "response.create" });
      return;
    }
    if (type === "error") {
      const err = event["error"] as { message?: string } | undefined;
      this.events.onError?.(new Error(err?.message ?? "Workshop voice error"));
    }
  }
}

function base64ToBuffer(b64: string): ArrayBuffer {
  if (typeof atob !== "function") {
    throw new Error("base64 audio decode requires a browser (atob).");
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
