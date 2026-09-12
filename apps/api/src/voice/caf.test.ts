import { describe, expect, it } from "vitest";
import { normalizePcm16, pcmDurationSeconds, pcmToCaf } from "./caf.ts";

describe("pcmToCaf", () => {
  it("writes a valid CAF header around S16LE PCM", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const caf = pcmToCaf(pcm, 24_000);
    const v = new DataView(caf.buffer);
    const ascii = (o: number) => String.fromCharCode(...caf.slice(o, o + 4));

    expect(ascii(0)).toBe("caff");
    expect(v.getUint16(4)).toBe(1); // version
    expect(ascii(8)).toBe("desc");
    expect(v.getBigInt64(12)).toBe(32n);
    expect(v.getFloat64(20)).toBe(24_000); // sample rate
    expect(ascii(28)).toBe("lpcm");
    expect(v.getUint32(32)).toBe(2); // little-endian flag
    expect(v.getUint32(36)).toBe(2); // bytes per packet (mono 16-bit)
    expect(v.getUint32(40)).toBe(1); // frames per packet
    expect(v.getUint32(44)).toBe(1); // channels
    expect(v.getUint32(48)).toBe(16); // bits
    expect(ascii(52)).toBe("data");
    expect(v.getBigInt64(56)).toBe(BigInt(4 + pcm.length));
    expect(v.getUint32(64)).toBe(0); // edit count
    expect(Array.from(caf.slice(68))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(caf.length).toBe(68 + pcm.length);
  });

  it("raises RMS toward the target with a soft-knee limiter and never hard-clips", () => {
    const s16 = (vals: number[]) => {
      const b = new Uint8Array(vals.length * 2);
      const v = new DataView(b.buffer);
      vals.forEach((x, i) => v.setInt16(i * 2, x, true));
      return b;
    };
    const read = (b: Uint8Array) => Array.from({ length: b.length / 2 }, (_, i) => new DataView(b.buffer, b.byteOffset).getInt16(i * 2, true));
    const rmsDb = (vals: number[]) => 20 * Math.log10(Math.sqrt(vals.reduce((s, v) => s + v * v, 0) / vals.length) / 32768);

    // A TTS-like signal: sine at about -14.5 dBFS RMS with one peak near full scale.
    const src = Array.from({ length: 2400 }, (_, i) => Math.round(6170 * Math.SQRT2 * Math.sin((i / 2400) * Math.PI * 40)));
    src[100] = 32000;
    const before = rmsDb(src);
    expect(before).toBeCloseTo(-14.5, 0);

    const { pcm, gain, rmsDbBefore } = normalizePcm16(s16(src));
    const out = read(pcm);
    expect(rmsDbBefore).toBeCloseTo(before, 3);
    expect(gain).toBeGreaterThan(1.4); // ≈ +4.5 dB toward −10 dBFS
    expect(rmsDb(out)).toBeGreaterThan(before + 3); // audibly louder
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(32767); // limiter: no wrap/clipping
    expect(out[100]).toBeGreaterThan(0.8 * 32767); // the peak was compressed, not chopped
    expect(out[0]).toBe(Math.round(src[0]! * gain)); // below the knee → linear

    // Already at target / silent → untouched
    const loud = Array.from({ length: 480 }, (_, i) => Math.round(0.45 * 32767 * Math.sin(i / 3)));
    expect(normalizePcm16(s16(loud)).gain).toBe(1);
    expect(normalizePcm16(s16([0, 0, 0])).gain).toBe(1);

    // Gain is capped for near-silent input.
    expect(normalizePcm16(s16(Array(480).fill(3))).gain).toBeCloseTo(Math.pow(10, 12 / 20), 3);
  });

  it("computes duration", () => {
    expect(pcmDurationSeconds(48_000, 24_000)).toBe(1);
  });
});
