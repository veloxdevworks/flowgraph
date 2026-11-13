import { FACILITATOR_TOOLS, type FacilitatorToolCall, type FacilitatorToolDef } from "./tools.js";
import type { WorkshopController } from "./controller.js";
import { voiceProvider } from "./providers.js";
import {
  WORKSHOP_SESSION_MAX_MS,
  type MintedVoiceToken,
  type WorkshopContract,
  type WorkshopTranscriptTurn,
} from "./types.js";

export type WorkshopSessionEvents = {
  onTranscript?: (turn: WorkshopTranscriptTurn) => void;
  onAssistantText?: (delta: string) => void;
  onAudioDelta?: (pcm24k: ArrayBuffer) => void;
  onSpeechStarted?: () => void;
  onToolCall?: (call: FacilitatorToolCall) => Promise<unknown> | unknown;
  onError?: (err: Error) => void;
  onExpired?: () => void;
  /**
   * Wall-clock limit reached (`contract.limits.maxMinutes`, else 30 min). The session
   * closes right after; resume with `endedReason: "timeout"` and the current draft.
   */
  onTimeLimit?: () => void;
  /** With a controller: the facilitator's `finish` was accepted; the socket closes right after. */
  onFinished?: (endedReason: string) => void;
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
  private limitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly token: MintedVoiceToken,
    private readonly contract: WorkshopContract,
    private readonly events: WorkshopSessionEvents = {},
    private readonly connect: typeof browserWebSocket = browserWebSocket,
    private readonly options: {
      /**
       * Shared session state. When set: its tools and instructions are used, tool calls are
       * applied to it, transcripts are recorded on it, and the socket closes on an accepted
       * `finish`. `events.onToolCall` is then only called for tools the controller does not
       * serve (e.g. `read_artifact`) and, as a notification, for the others.
       */
      controller?: WorkshopController;
      /** With a controller: also advertise `read_artifact` (answer it in `onToolCall`). */
      readArtifact?: boolean;
    } = {},
  ) {}

  get provider() {
    return voiceProvider(this.token.provider);
  }

  async start(
    opts: {
      instructions?: string;
      voice?: string;
      seedTranscript?: string;
      vad?: boolean;
      /** Tools advertised to the model. Default FACILITATOR_TOOLS (no read_artifact). */
      tools?: readonly FacilitatorToolDef[];
    } = {},
  ): Promise<void> {
    const voice = opts.voice ?? this.contract.voice?.voice ?? this.provider.defaultVoice;
    const ctl = this.options.controller;
    const instructions =
      opts.instructions ??
      (ctl
        ? ctl.instructions(opts.seedTranscript ? { seedTranscript: opts.seedTranscript } : {})
        : this.buildInstructions(opts.seedTranscript));
    const tools =
      opts.tools ?? (ctl ? ctl.tools({ readArtifact: this.options.readArtifact === true }) : FACILITATOR_TOOLS);
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
          tools,
        },
      });
    });
    this.startLimitTimer();
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

  /** Session wall-clock budget in ms (`limits.maxMinutes`, else WORKSHOP_SESSION_MAX_MS). */
  get timeLimitMs(): number {
    if (this.options.controller) return this.options.controller.limits.timeLimitMs;
    const minutes = this.contract.limits?.maxMinutes;
    return typeof minutes === "number" && minutes > 0 ? minutes * 60_000 : WORKSHOP_SESSION_MAX_MS;
  }

  close(): void {
    this.closed = true;
    if (this.limitTimer) {
      clearTimeout(this.limitTimer);
      this.limitTimer = null;
    }
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
      "Call update_draft as facts land. Call cover_agenda_item when a topic is done. Call finish when the schema is satisfied or the human ends the session. If finish returns an error, the session is still open: ask the human for what is missing.",
      `Agenda:\n${agenda || "(none)"}`,
      `Output JSON Schema:\n${schema}`,
      context ? `Primed context:\n${context}` : "",
      seed,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private startLimitTimer(): void {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = setTimeout(() => {
      this.limitTimer = null;
      if (this.closed) return;
      const ctl = this.options.controller;
      if (ctl && !ctl.ended) {
        try {
          ctl.end("timeout"); // accepted only when the contract allows a partial end
        } catch {
          // the host decides what to do with an unfinished draft
        }
      }
      this.events.onTimeLimit?.();
      this.close();
    }, this.timeLimitMs);
  }

  private recordTranscript(turn: WorkshopTranscriptTurn): void {
    this.options.controller?.addTurn(turn);
    this.events.onTranscript?.(turn);
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
      if (transcript) this.recordTranscript({ role: "assistant", text: transcript, at: new Date().toISOString() });
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
      if (transcript) this.recordTranscript({ role: "user", text: transcript, at: new Date().toISOString() });
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
      const call = { name, callId, args };
      const ctl = this.options.controller;
      let result: unknown;
      let ended: string | undefined;
      if (ctl && ctl.handles(name)) {
        const applied = ctl.apply(call);
        result = applied.result;
        if (applied.ended) ended = ctl.state.endedReason;
        await this.events.onToolCall?.(call); // notification only
      } else {
        result = await this.events.onToolCall?.(call);
      }
      this.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(result ?? { ok: true }),
        },
      });
      if (ended !== undefined) {
        this.events.onFinished?.(ended);
        this.close();
        return;
      }
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
