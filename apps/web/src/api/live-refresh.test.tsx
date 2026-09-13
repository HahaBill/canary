/**
 * The live heartbeat and the stale-while-revalidate contract behind it.
 *
 * The backend's demo clock moves a simulated day per real minute; the SPA picks
 * that up by clearing its response cache on an interval. What these tests pin
 * is the part a viewer would notice: a refresh swaps numbers IN PLACE. The
 * dashboard must never collapse to skeletons or an error page because time
 * passed.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearApiCache, startLiveRefresh, useDerived } from "./useDerived.ts";
import { resetMockSnapshot } from "./mock.ts";

function Probe() {
  const { data, loading, error } = useDerived();
  return (
    <div>
      <span data-testid="cash">{data ? String(data.cash_cents) : "no-data"}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error ?? "none"}</span>
    </div>
  );
}

describe("stale-while-revalidate", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_USE_MOCK", "1");
    window.localStorage.clear();
    clearApiCache();
    resetMockSnapshot();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps the numbers on screen while a refresh is in flight", async () => {
    render(<Probe />);
    const cash = await screen.findByTestId("cash");
    const before = cash.textContent;
    expect(before).not.toBe("no-data");

    // The heartbeat fires. The old figure must still be there in the same
    // breath — a blank dashboard every 30 seconds reads as broken, not live.
    act(() => clearApiCache());
    expect(screen.getByTestId("cash").textContent).toBe(before);

    await screen.findByText("false", { selector: '[data-testid="loading"]' });
    expect(screen.getByTestId("cash").textContent).toBe(before);
    expect(screen.getByTestId("error").textContent).toBe("none");
  });
});

describe("startLiveRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears the cache on its interval and stops when told to", async () => {
    const listener = vi.fn();
    const { subscribeToCacheForTests } = await import("./useDerived.ts");
    const unsubscribe = subscribeToCacheForTests(listener);

    const stop = startLiveRefresh(1_000);
    vi.advanceTimersByTime(3_100);
    expect(listener).toHaveBeenCalledTimes(3);

    stop();
    vi.advanceTimersByTime(5_000);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("does nothing while the tab is hidden", () => {
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const listener = vi.fn();

    return import("./useDerived.ts").then(({ subscribeToCacheForTests }) => {
      const unsubscribe = subscribeToCacheForTests(listener);
      const stop = startLiveRefresh(1_000);
      vi.advanceTimersByTime(3_100);
      expect(listener).not.toHaveBeenCalled();

      spy.mockReturnValue("visible");
      vi.advanceTimersByTime(1_100);
      expect(listener).toHaveBeenCalled();

      stop();
      unsubscribe();
    });
  });
});
