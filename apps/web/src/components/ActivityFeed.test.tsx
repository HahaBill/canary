import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { Transaction } from "@canary/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Transaction[],
  useRecentTransactions: vi.fn(),
}));

vi.mock("@/api/useDerived.ts", () => ({
  useRecentTransactions: mocks.useRecentTransactions,
}));

import { ActivityFeed } from "@/components/ActivityFeed.tsx";

function transaction(
  id: string,
  date: string,
  merchant: string,
  options: Pick<Transaction, "status" | "pending_of"> = { status: "settled" },
): Transaction {
  return {
    id,
    account_id: "checking",
    date,
    amount_cents: -10_000,
    currency: "USD",
    merchant_raw: merchant.toUpperCase(),
    merchant_normalized: merchant,
    description: `${merchant} charge`,
    flow_type: "OPERATING_OUTFLOW",
    status: options.status,
    source: "synthetic",
    tags: [],
    ...(options.pending_of ? { pending_of: options.pending_of } : {}),
  };
}

function rowFor(name: string): HTMLLIElement {
  return screen.getByText(name).closest("li") as HTMLLIElement;
}

describe("ActivityFeed arrivals", () => {
  afterEach(() => {
    cleanup();
    mocks.rows = [];
    mocks.useRecentTransactions.mockReset();
  });

  it("highlights replayed rows again after the demo clock wraps", async () => {
    mocks.rows = [transaction("start-aws", "2026-08-15", "aws")];
    mocks.useRecentTransactions.mockImplementation(() => ({
      data: mocks.rows,
      loading: false,
      error: null,
      source: "live",
      reload: vi.fn(),
    }));

    const { rerender } = render(<ActivityFeed asOf="2026-08-15" />);
    expect(rowFor("AWS")).toHaveClass("bg-transparent");

    mocks.rows = [transaction("end-figma", "2026-09-13", "figma")];
    rerender(<ActivityFeed asOf="2026-09-13" />);
    await waitFor(() => expect(rowFor("Figma")).toHaveClass("bg-canary-50/70"));

    // The bounded clock returns to its start. This row was shown one cycle ago,
    // but it is arriving in the feed again and must not be suppressed forever.
    mocks.rows = [transaction("start-aws", "2026-08-15", "aws")];
    rerender(<ActivityFeed asOf="2026-08-15" />);
    await waitFor(() => expect(rowFor("AWS")).toHaveClass("bg-canary-50/70"));
  });

  it("replaces a returned pending row with its settled twin", () => {
    mocks.rows = [
      transaction("vercel-pending", "2026-09-12", "vercel", { status: "pending" }),
      transaction("vercel-settled", "2026-09-13", "vercel", {
        status: "settled",
        pending_of: "vercel-pending",
      }),
    ];
    mocks.useRecentTransactions.mockReturnValue({
      data: mocks.rows,
      loading: false,
      error: null,
      source: "live",
      reload: vi.fn(),
    });

    render(<ActivityFeed asOf="2026-09-13" />);

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Vercel")).toBeInTheDocument();
    expect(screen.queryByText("pending", { exact: false })).not.toBeInTheDocument();
  });

  it("keeps and labels an unmatched pending authorisation", () => {
    mocks.rows = [transaction("vercel-pending", "2026-09-13", "vercel", { status: "pending" })];
    mocks.useRecentTransactions.mockReturnValue({
      data: mocks.rows,
      loading: false,
      error: null,
      source: "live",
      reload: vi.fn(),
    });

    render(<ActivityFeed asOf="2026-09-13" />);

    expect(within(rowFor("Vercel")).getByText(/pending/)).toBeInTheDocument();
  });
});
