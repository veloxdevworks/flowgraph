import { PCM_CAPTURE_WORKLET_SRC, resampleToRate } from "../audio.js";
import { concatFloat32, encodeWav, rmsLevel } from "../wav.js";

export const DICTATION_SAMPLE_RATE = 16_000;

export type DictationOptions = {
  deviceId?: string;
  /** Auto-stop after this many seconds (the clip is kept). Default 120. */
  maxSeconds?: number;
  /** Called with the RMS level (0..1) of each captured chunk. */
  onLevel?: (rms: number) => void;
};

export type DictationHandle = {
  /** Stop recording and return the clip as 16 kHz mono WAV. Safe to call more than once. */
  stop(): Promise<{ wav: Blob; durationMs: number }>;
  /** Stop and discard. A later `stop()` rejects. */
  cancel(): void;
};

/**
 * Record a push-to-talk clip in the browser. Send `wav` to a host-side `Transcriber`
 * and put the text in the input box for the human to check.
 */
export async function startDictation(opts: DictationOptions = {}): Promise<DictationHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
    },
  });
  const ctx = new AudioContext();
  const chunks: Float32Array[] = [];
  let node: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  try {
    const url = URL.createObjectURL(new Blob([PCM_CAPTURE_WORKLET_SRC], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "pcm-capture");
    node.port.onmessage = (ev) => {
      const samples = ev.data as Float32Array;
      chunks.push(samples);
      opts.onLevel?.(rmsLevel(samples));
    };
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
  } catch (err) {
    for (const t of stream.getTracks()) t.stop();
    void ctx.close();
    throw err;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let result: Promise<{ wav: Blob; durationMs: number }> | undefined;
  const teardown = () => {
    if (timer) clearTimeout(timer);
    node?.disconnect();
    source?.disconnect();
    for (const t of stream.getTracks()) t.stop();
    void ctx.close();
  };
  const finalize = (): Promise<{ wav: Blob; durationMs: number }> => {
    result ??= (async () => {
      const rate = ctx.sampleRate;
      teardown();
      if (cancelled) throw new Error("dictation cancelled");
      const all = concatFloat32(chunks);
      const pcm = resampleToRate(all, rate, DICTATION_SAMPLE_RATE);
      return {
        wav: new Blob([encodeWav(pcm, DICTATION_SAMPLE_RATE) as BlobPart], { type: "audio/wav" }),
        durationMs: Math.round((all.length / rate) * 1000),
      };
    })();
    return result;
  };
  timer = setTimeout(() => void finalize().catch(() => undefined), (opts.maxSeconds ?? 120) * 1000);
  return {
    stop: finalize,
    cancel() {
      cancelled = true;
      void finalize().catch(() => undefined);
    },
  };
}
