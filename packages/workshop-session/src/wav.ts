/** Pure audio helpers (no DOM): WAV encoding and level metering. */

/** Encode mono 16-bit PCM WAV (44-byte RIFF header). Float samples are clamped to [-1, 1]. */
export function encodeWav(samples: Float32Array | Int16Array, sampleRate: number): Uint8Array {
  const dataLen = samples.length * 2;
  const out = new Uint8Array(44 + dataLen);
  const view = new DataView(out.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataLen, true);
  const isFloat = samples instanceof Float32Array;
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i] ?? 0;
    if (isFloat) {
      v = Math.max(-1, Math.min(1, v));
      v = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    view.setInt16(44 + i * 2, Math.round(v), true);
  }
  return out;
}

/** Root-mean-square level of a Float32 chunk, 0..1. */
export function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / samples.length);
}

/** Concatenate Float32 chunks. */
export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
