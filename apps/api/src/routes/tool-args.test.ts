import { describe, expect, it } from "vitest";
import { unwrapToolArgs } from "./tool-args.ts";

describe("unwrapToolArgs", () => {
  it("passes a flat body through and maps spoken aliases", () => {
    expect(unwrapToolArgs({ vendor: "cloud", percent: -20 })).toEqual({
      vendor: "cloud",
      percent: -20,
      entity: "cloud",
      percentage: -20,
    });
  });

  it("unwraps ElevenLabs parameters / arguments / tool_call wrappers", () => {
    expect(unwrapToolArgs({ parameters: { entity: "aws" } })).toEqual({ entity: "aws" });
    expect(unwrapToolArgs({ arguments: JSON.stringify({ id: "inc_1" }) })).toEqual({
      id: "inc_1",
      incident_id: "inc_1",
    });
    expect(
      unwrapToolArgs({
        conversation_id: "conv_1",
        tool_name: "get_vendor_spend",
        tool_call: { parameters: { vendor: "cloud cost" } },
      }),
    ).toEqual({ vendor: "cloud cost", entity: "cloud cost" });
  });
});
