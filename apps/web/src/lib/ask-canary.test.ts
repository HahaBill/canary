import { AGENT_TOOL_NAMES } from "@canary/shared";
import { describe, expect, it, vi } from "vitest";
import { createAskCanaryClientTools, runAskCanaryClientTool } from "./ask-canary.ts";

describe("Ask Canary client tools", () => {
  it("exposes every iMessage tool name", () => {
    expect(Object.keys(createAskCanaryClientTools()).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
  });

  it("POSTs arguments to /api/tools/<name> and returns the JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ known: true, vendor: "AWS" }), { status: 200 }));
    await expect(runAskCanaryClientTool("get_vendor_spend", { entity: "cloud" }, fetchImpl)).resolves.toEqual({
      known: true,
      vendor: "AWS",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/get_vendor_spend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entity: "cloud" }),
    });
  });
});
