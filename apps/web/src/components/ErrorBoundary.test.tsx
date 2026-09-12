import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "@/components/ErrorBoundary.tsx";

function Boom(): never {
  throw new Error("weekly buckets were empty");
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    // React and the boundary both log the caught error; that is expected here.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("passes children through when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>Cash $2,012,880.19</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText("Cash $2,012,880.19")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("catches a render error and offers a reload with the detail", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not load this view");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();

    const details = screen.getByText("Error detail").closest("details");
    expect(details).not.toBeNull();
    expect(details).toHaveTextContent("weekly buckets were empty");
    // Collapsed by default: the message is available, not shouted.
    expect(details).not.toHaveAttribute("open");
  });
});
