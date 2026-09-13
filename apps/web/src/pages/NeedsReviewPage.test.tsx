import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatUsdWhole } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { resetMockSnapshot } from "@/api/mock.ts";
import { clearApiCache } from "@/api/useDerived.ts";
import { installApiStub, renderApp, setViewport, type RecordedRequest } from "@/test-utils.tsx";

const derived = buildMockDerived();
const item = derived.needs_review.items[0]!;

describe("NeedsReviewPage", () => {
  let requests: RecordedRequest[];

  beforeEach(() => {
    ({ requests } = installApiStub());
    setViewport(1280);
    window.localStorage.clear();
    clearApiCache();
    resetMockSnapshot();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("heads the queue with the engine's count and outflow", async () => {
    renderApp("/needs-review");

    const heading = await screen.findByRole("heading", { name: "Needs Review" });
    expect(heading.parentElement).toHaveTextContent(
      formatUsdWhole(derived.needs_review.outflow_cents).replace(/\u00a0/g, " "),
    );
    expect(screen.getByText(item.merchant_raw)).toBeInTheDocument();
    expect(screen.getByText(item.reason)).toBeInTheDocument();
  });

  it("shows the disagreeing proposals that landed the row here", async () => {
    renderApp("/needs-review");
    await screen.findByText(item.merchant_raw);

    expect(screen.getByText("OpenAI → Professional services")).toBeInTheDocument();
    const research = screen.getByText("Research → SaaS software ↗");
    expect(research.closest("a")).toHaveAttribute("href", derived.vendor_enrichments[0]!.source_url);
  });

  it("lets the reviewer assign without an operator secret", async () => {
    renderApp("/needs-review");
    await screen.findByText(item.merchant_raw);

    expect(screen.queryByLabelText("Enter operator secret")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Assign category" }));
    expect(screen.queryByText(/Enter the operator secret above/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save category" })).toBeEnabled();
  });

  it("makes the reviewer pick a category rather than accepting a default", async () => {
    renderApp("/needs-review");
    await screen.findByText(item.merchant_raw);

    fireEvent.click(screen.getByRole("button", { name: "Assign category" }));
    const select = screen.getByLabelText(/Category/);
    expect(within(select).getByRole("option", { name: "Choose a category…" })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save category" })).toBeDisabled();
  });

  it("submits an override without a secret header and drops the row", async () => {
    renderApp("/needs-review");
    await screen.findByText(item.merchant_raw);

    fireEvent.click(screen.getByRole("button", { name: "Assign category" }));
    const form = screen.getByRole("dialog", { name: new RegExp(item.merchant_raw) });
    fireEvent.change(within(form).getByLabelText(/Category/), {
      target: { value: "PROFESSIONAL_SERVICES" },
    });
    // On by default: one merchant, one decision.
    expect(within(form).getByRole("checkbox")).toBeChecked();
    fireEvent.change(within(form).getByLabelText(/Note/), { target: { value: "Known contractor" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save category" }));

    const override = await waitFor(() => {
      const found = requests.find((r) => r.path === "/api/classifications/override");
      if (!found) throw new Error("override not submitted yet");
      return found;
    });
    expect(override.method).toBe("POST");
    expect(override.headers["x-canary-secret"]).toBeUndefined();
    expect(override.body).toEqual({
      transaction_id: item.transaction_id,
      category: "PROFESSIONAL_SERVICES",
      apply_to_merchant: true,
      note: "Known contractor",
    });

    await waitFor(() => expect(screen.queryByText(item.merchant_raw)).not.toBeInTheDocument());
    expect(await screen.findByText(/The queue is empty/)).toBeInTheDocument();
  });

  it("confirms the save and records it under recent overrides", async () => {
    renderApp("/needs-review");
    await screen.findByText(item.merchant_raw);

    fireEvent.click(screen.getByRole("button", { name: "Assign category" }));
    fireEvent.click(screen.getByRole("button", { name: "Save category" }));

    expect(await screen.findByText(/filed under/)).toBeInTheDocument();
    expect(await screen.findByText("Recent overrides")).toBeInTheDocument();
  });

  it("clears the sidebar badge once the queue empties", async () => {
    renderApp("/needs-review");
    await screen.findByText(item.merchant_raw);

    const sidebar = screen.getByRole("complementary", { name: "Main navigation" });
    expect(within(sidebar).getByRole("link", { name: /Needs Review/ })).toHaveTextContent(
      String(derived.needs_review.count),
    );

    fireEvent.click(screen.getByRole("button", { name: "Assign category" }));
    fireEvent.click(screen.getByRole("button", { name: "Save category" }));

    await waitFor(() =>
      expect(
        within(screen.getByRole("complementary", { name: "Main navigation" })).getByRole("link", {
          name: /Needs Review/,
        }),
      ).not.toHaveTextContent(String(derived.needs_review.count)),
    );
  });
});
