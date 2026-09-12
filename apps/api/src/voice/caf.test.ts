import { describe, expect, it } from "vitest";
import { pcmDurationSeconds, pcmToCaf } from "./caf.ts";

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

  it("computes duration", () => {
    expect(pcmDurationSeconds(48_000, 24_000)).toBe(1);
  });
});
