import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMonths, type AlertHistoryItem } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { AlertsStrip, relativeTime } from "@/components/AlertsStrip.tsx";
import { clearApiCache } from "@/api/useDerived.ts";
import { mockAlertHistory, resetMockSnapshot } from "@/api/mock.ts";

const NOW = new Date("2026-09-12T18:00:00.000Z");

/** Newest first, the way the route returns them — the strip does not re-sort. */
const ITEMS: AlertHistoryItem[] = [
  {
    id: 3,
    direction: "outbound",
    phone: "+15550000000",
    body: "CUSUM flagged it. Change point: week of 2026-06-29.",
    created_at: "2026-09-12T17:30:00.000Z",
    command: "WHY",
    voice: false,
  },
  {
    id: 2,
    direction: "inbound",
    phone: "+15550000000",
    body: "WHY",
    created_at: "2026-09-12T17:00:00.000Z",
    command: "WHY",
    voice: false,
  },
  {
    id: 1,
    direction: "outbound",
    phone: "+15550000000",
    body: "Variable spend is up +$4,127/wk.\nReply WHY for the detector parameters.",
    created_at: "2026-09-12T16:00:00.000Z",
    command: null,
    voice: true,
  },
];

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(() => Promise.resolve(response()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("AlertsStrip", () => {
  beforeEach(() => {
    clearApiCache();
    resetMockSnapshot();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("renders the conversation newest-first with voice and command chips", async () => {
    const fetchMock = stubFetch(() => json({ items: ITEMS }));

    render(<AlertsStrip now={NOW} />);

    const strip = await screen.findByRole("region", { name: "Conversation" });
    expect(fetchMock).toHaveBeenCalledWith("/api/alerts/history?limit=8", expect.anything());

    const entries = screen.getAllByRole("listitem");
    expect(entries).toHaveLength(3);
    // Only the first line of the body is previewed.
    expect(entries[0]).toHaveTextContent("CUSUM flagged it. Change point: week of 2026-06-29.");
    expect(entries[2]).toHaveTextContent("Variable spend is up +$4,127/wk.");
    expect(entries[2]).not.toHaveTextContent("Reply WHY");

    expect(strip).toHaveTextContent("voice note");
    expect(screen.getAllByText("WHY").length).toBeGreaterThan(0);
    expect(entries[0]).toHaveTextContent("30m ago");
    expect(entries[2]).toHaveTextContent("2h ago");
  });

  it("distinguishes who spoke", async () => {
    stubFetch(() => json({ items: ITEMS }));
    render(<AlertsStrip now={NOW} />);

    await screen.findByRole("region", { name: "Conversation" });
    expect(screen.getAllByText("Canary")).toHaveLength(2);
    expect(screen.getByText("Founder")).toBeInTheDocument();
  });

  it("says so when nothing has been sent", async () => {
    stubFetch(() => json({ items: [] }));
    render(<AlertsStrip now={NOW} />);

    expect(await screen.findByText("No alerts sent yet.")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("hides itself when the route answers with an error", async () => {
    // 4xx is not "unreachable", so no fixture fallback kicks in.
    stubFetch(() => json({ error: "not found" }, 404));
    const { container } = render(<AlertsStrip now={NOW} />);

    await vi.waitFor(() => expect(container.querySelector("section")).toBeNull());
  });

  it("passes the limit through to the route", async () => {
    const fetchMock = stubFetch(() => json({ items: ITEMS }));
    render(<AlertsStrip limit={3} now={NOW} />);

    await screen.findByRole("region", { name: "Conversation" });
    expect(fetchMock).toHaveBeenCalledWith("/api/alerts/history?limit=3", expect.anything());
  });

  it("renders the offline fixture conversation without gaps", async () => {
    vi.stubEnv("VITE_USE_MOCK", "1");
    const derived = buildMockDerived();
    const expected = mockAlertHistory();

    render(<AlertsStrip now={new Date(derived.provenance.generated_at)} />);

    const strip = await screen.findByRole("region", { name: "Conversation" });
    expect(screen.getAllByRole("listitem")).toHaveLength(expected.length);
    // The demo beat: an alert, a voice note, the founder's WHY and the reply.
    expect(strip).toHaveTextContent("voice note");
    expect(screen.getByText("Founder")).toBeInTheDocument();
    // Every preview is real copy rendered from the derived object.
    expect(strip.textContent).not.toMatch(/undefined|NaN|\$\s*$/);
    expect(strip).toHaveTextContent(formatMonths(derived.burn.runway_months));
  });

  describe("relativeTime", () => {
    it("reads in minutes, hours and days", () => {
      expect(relativeTime("2026-09-12T17:58:00.000Z", NOW)).toBe("2m ago");
      expect(relativeTime("2026-09-12T12:00:00.000Z", NOW)).toBe("6h ago");
      expect(relativeTime("2026-09-09T18:00:00.000Z", NOW)).toBe("3d ago");
    });

    it("does not go backwards for clock skew", () => {
      expect(relativeTime("2026-09-12T18:00:30.000Z", NOW)).toBe("just now");
    });
  });
});
