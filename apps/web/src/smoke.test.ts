import { describe, expect, it } from "vitest";
import { formatUsdCompact } from "@canary/shared";

describe("web smoke", () => {
  it("imports shared", () => {
    expect(formatUsdCompact(100_000)).toBe("$1K");
  });
});
