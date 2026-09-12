/**
 * Minimal Core Audio Format (CAF) writer for 16-bit little-endian linear PCM.
 *
 * iMessage renders a `.caf` attachment as a native voice memo (Sendblue docs:
 * guides/voice-notes). ElevenLabs can emit raw S16LE PCM, so wrapping it in a
 * CAF container here avoids any transcoding step (no ffmpeg in a Worker).
 *
 * Layout (all header integers big-endian, per Apple's CAF spec):
 *   'caff' | u16 version=1 | u16 flags=0
 *   'desc' | i64 size=32 | f64 sampleRate | 'lpcm' | u32 flags | u32 bytesPerPacket
 *          | u32 framesPerPacket | u32 channelsPerFrame | u32 bitsPerChannel
 *   'data' | i64 size=4+len | u32 editCount=0 | pcm bytes
 */

const FLAG_IS_LITTLE_ENDIAN = 2; // kCAFLinearPCMFormatFlagIsLittleEndian

function chunkHeader(type: string, size: number): Uint8Array {
  const b = new Uint8Array(12);
  const v = new DataView(b.buffer);
  for (let i = 0; i < 4; i++) b[i] = type.charCodeAt(i);
  v.setBigInt64(4, BigInt(size));
  return b;
}

export function pcmToCaf(pcm: Uint8Array, sampleRate: number, channels = 1, bitsPerChannel = 16): Uint8Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error(`invalid sampleRate ${sampleRate}`);
  const bytesPerFrame = channels * (bitsPerChannel / 8);

  const fileHeader = new Uint8Array([0x63, 0x61, 0x66, 0x66, 0x00, 0x01, 0x00, 0x00]); // 'caff', v1, flags 0

  const desc = new Uint8Array(32);
  const d = new DataView(desc.buffer);
  d.setFloat64(0, sampleRate);
  desc.set([0x6c, 0x70, 0x63, 0x6d], 8); // 'lpcm'
  d.setUint32(12, FLAG_IS_LITTLE_ENDIAN);
  d.setUint32(16, bytesPerFrame);
  d.setUint32(20, 1);
  d.setUint32(24, channels);
  d.setUint32(28, bitsPerChannel);

  const editCount = new Uint8Array(4);
  const parts = [fileHeader, chunkHeader("desc", 32), desc, chunkHeader("data", 4 + pcm.length), editCount, pcm];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Loudness-normalize S16LE PCM for an iMessage voice memo.
 *
 * TTS output already peaks near full scale but averages around −14 dBFS, so it
 * sounds quiet next to phone-recorded voice notes (which are heavily
 * compressed). We apply gain to reach `targetRmsDb` and run the result through
 * a soft-knee limiter: samples below `knee` (fraction of full scale) pass
 * linearly, anything above is compressed smoothly toward full scale, so peaks
 * never hard-clip. `maxGainDb` caps amplification for near-silent input.
 */
export function normalizePcm16(pcm: Uint8Array, targetRmsDb = -10, maxGainDb = 12, knee = 0.8): { pcm: Uint8Array; gain: number; rmsDbBefore: number } {
  const samples = pcm.length >> 1;
  if (samples === 0) return { pcm, gain: 1, rmsDbBefore: -Infinity };
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const v = view.getInt16(i * 2, true);
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / samples);
  if (rms === 0) return { pcm, gain: 1, rmsDbBefore: -Infinity };
  const rmsDb = 20 * Math.log10(rms / 32768);
  const gainDb = Math.max(0, Math.min(maxGainDb, targetRmsDb - rmsDb));
  const gain = Math.pow(10, gainDb / 20);
  if (gain <= 1.001) return { pcm, gain: 1, rmsDbBefore: rmsDb };

  const FULL = 32767;
  const kneeAbs = knee * FULL;
  const headroom = FULL - kneeAbs;
  const out = new Uint8Array(samples * 2);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) {
    const x = view.getInt16(i * 2, true) * gain;
    const a = Math.abs(x);
    // Soft knee: linear below the knee, tanh-compressed above it, asymptotic to FULL.
    const y = a <= kneeAbs ? a : kneeAbs + headroom * Math.tanh((a - kneeAbs) / headroom);
    ov.setInt16(i * 2, Math.round(Math.sign(x) * Math.min(FULL, y)), true);
  }
  return { pcm: out, gain, rmsDbBefore: rmsDb };
}

/** Duration of S16LE PCM in seconds. */
export function pcmDurationSeconds(pcmBytes: number, sampleRate: number, channels = 1): number {
  return pcmBytes / (sampleRate * channels * 2);
}
