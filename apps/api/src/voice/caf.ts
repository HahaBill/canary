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

/** Duration of S16LE PCM in seconds. */
export function pcmDurationSeconds(pcmBytes: number, sampleRate: number, channels = 1): number {
  return pcmBytes / (sampleRate * channels * 2);
}
