/** Browser mic capture + PCM playback for workshop voice sessions (24 kHz). */

export const WORKSHOP_PCM_RATE = 24_000;

const WORKLET_SRC = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input && input.length) {
      this.port.postMessage(input);
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCaptureProcessor);
`;

export function floatToPcm16Base64(samples: Float32Array): string {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function resampleToRate(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
  }
  return out;
}

export type MicCapture = {
  stop: () => void;
  stream: MediaStream;
};

export async function startMicCapture(
  onPcm16Base64: (b64: string) => void,
  opts: { deviceId?: string } = {},
): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
    },
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const blob = new Blob([WORKLET_SRC], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const node = new AudioWorkletNode(ctx, "pcm-capture");
  node.port.onmessage = (ev) => {
    const samples = ev.data as Float32Array;
    const resampled = resampleToRate(samples, ctx.sampleRate, WORKSHOP_PCM_RATE);
    onPcm16Base64(floatToPcm16Base64(resampled));
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
  return {
    stream,
    stop: () => {
      node.disconnect();
      source.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void ctx.close();
    },
  };
}

export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private nextAt = 0;
  private sources: AudioBufferSourceNode[] = [];

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: WORKSHOP_PCM_RATE });
      this.nextAt = this.ctx.currentTime;
    }
    return this.ctx;
  }

  enqueue(pcm24k: ArrayBuffer): void {
    const ctx = this.ensure();
    const int16 = new Int16Array(pcm24k);
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = (int16[i] ?? 0) / 0x8000;
    const buffer = ctx.createBuffer(1, f32.length, WORKSHOP_PCM_RATE);
    buffer.copyToChannel(f32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = Math.max(this.nextAt, ctx.currentTime);
    src.start(startAt);
    this.nextAt = startAt + buffer.duration;
    this.sources.push(src);
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src);
    };
  }

  /** Barge-in: stop queued playback immediately. */
  interrupt(): void {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.sources = [];
    if (this.ctx) this.nextAt = this.ctx.currentTime;
  }

  close(): void {
    this.interrupt();
    void this.ctx?.close();
    this.ctx = null;
  }
}
