import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DataProvenance } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { MockBanner } from "@/components/MockBanner.tsx";

const mockProvenance = buildMockDerived().provenance;

const syntheticProvenance: DataProvenance = {
  ...mockProvenance,
  balance_source: "sandbox_bank",
  history_source: "synthetic",
};

describe("MockBanner", () => {
  afterEach(cleanup);

  it("warns loudly when the history source is mock", () => {
    render(<MockBanner provenance={mockProvenance} source="mock-forced" />);

    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("MOCK DATA — not generator output");
    expect(banner).toHaveTextContent("VITE_USE_MOCK=1");
  });

  it("explains a fallback to fixtures", () => {
    render(<MockBanner provenance={mockProvenance} source="mock-fallback" />);

    expect(screen.getByRole("alert")).toHaveTextContent("API was unreachable");
  });

  it("renders nothing for synthetic history", () => {
    render(<MockBanner provenance={syntheticProvenance} source="live" />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/MOCK DATA/)).toBeNull();
  });
});
