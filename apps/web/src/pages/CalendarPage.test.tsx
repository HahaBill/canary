import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailabilityResponse, CalendarConnectionResponse, CashCalendar } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { resetMockSnapshot } from "@/api/mock.ts";
import { clearApiCache } from "@/api/useDerived.ts";
import { formatDateMedium, WEEKDAY_LABELS } from "@/lib/format.ts";
import { installApiStub, renderApp, setViewport, type RecordedRequest } from "@/test-utils.tsx";

const START_URL = "https://canary.bill-nguyentonhoang.workers.dev/oauth/google/start?secret=<WEBHOOK_SECRET>";

function noneConnection(overrides: Partial<CalendarConnectionResponse> = {}): CalendarConnectionResponse {
  return {
    provider: "none",
    google_oauth_configured: true,
    expected_account: "bill.nguyentonhoang@gmail.com",
    oauth_start_url: START_URL,
    ...overrides,
  };
}

const derived = buildMockDerived();
/** Same clock the availability endpoint uses in fixtures. */
const today = derived.provenance.generated_at.slice(0, 10);

describe("CalendarPage", () => {
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

  it("opens on the month Canary is checking and asks for exactly that range", async () => {
    renderApp("/calendar");

    await screen.findByRole("button", { name: new RegExp(`^${today.slice(0, 8)}01`) });
    expect(screen.getByRole("heading", { name: "When Canary can text" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "September 2026" })).toBeInTheDocument();

    const request = requests.find((r) => r.path === "/api/calendar");
    expect(request?.params.get("from")).toBe("2026-09-01");
    expect(request?.params.get("to")).toBe("2026-09-30");
  });

  it("lays out a Monday-first grid with a cell per visible day", async () => {
    renderApp("/calendar");
    await screen.findByRole("button", { name: /^2026-09-01/ });

    for (const label of WEEKDAY_LABELS) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    const dayCells = screen.getAllByRole("button", { name: /^2026-\d{2}-\d{2}, / });
    expect(dayCells).toHaveLength(35);
    expect(dayCells[0]).toHaveAccessibleName(/^2026-08-31/);
  });

  it("shows busy blocks and the can-text pill, never ledger amounts", async () => {
    renderApp("/calendar");
    await screen.findByRole("button", { name: /^2026-09-01/ });

    const busy = screen.getByRole("button", { name: /^2026-09-02, in a meeting/ });
    expect(within(busy).getByText("Busy")).toBeInTheDocument();

    const free = screen.getByRole("button", { name: /^2026-09-03, Canary can text/ });
    expect(within(free).queryByText("AWS")).not.toBeInTheDocument();

    expect(screen.getAllByText("Canary can text").length).toBeGreaterThan(0);
    expect(screen.getByText(/private calendar feed/)).toBeInTheDocument();
    expect(screen.queryByText(/posted/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/expected/i)).not.toBeInTheDocument();
  });

  it("returns to today with Today", async () => {
    renderApp("/calendar");
    await screen.findByRole("button", { name: /^2026-09-01/ });

    expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await screen.findByRole("heading", { name: "August 2026" });

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(await screen.findByRole("heading", { name: "September 2026" })).toBeInTheDocument();
  });

  it("opens a day panel that explains whether Canary will wait", async () => {
    renderApp("/calendar");
    await screen.findByRole("button", { name: /^2026-09-01/ });

    fireEvent.click(screen.getByRole("button", { name: /^2026-09-02, in a meeting/ }));

    const panel = await screen.findByRole("dialog");
    expect(within(panel).getByText(formatDateMedium("2026-09-02"))).toBeInTheDocument();
    expect(within(panel).getByText(/hold iMessage alerts/)).toBeInTheDocument();
    expect(within(panel).queryByText("Posted")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("link", { name: "View in ledger" })).not.toBeInTheDocument();
  });

  it("explains when Google is not connected and names the operator start URL", async () => {
    installApiStub({
      calendarConnection: noneConnection(),
      availability: {
        busy: false,
        until: null,
        next_busy_start: null,
        source: "none",
        checked_at: derived.provenance.generated_at,
      },
    });
    renderApp("/calendar");
    expect(await screen.findByText(/No Google Calendar connected/)).toBeInTheDocument();
    expect(screen.getByText(START_URL)).toBeInTheDocument();
    expect(screen.getByText("bill.nguyentonhoang@gmail.com")).toBeInTheDocument();
    expect(screen.getByText(/Testing-mode refresh tokens expire after 7 days/)).toBeInTheDocument();
    expect(screen.queryByText("test-webhook-secret")).not.toBeInTheDocument();
    expect(screen.getByText("No calendar — texts immediately")).toBeInTheDocument();
  });

  it("tells the operator to set GOOGLE_* when the Worker cannot start OAuth", async () => {
    installApiStub({
      calendarConnection: noneConnection({
        google_oauth_configured: false,
        expected_account: undefined,
      }),
    });
    renderApp("/calendar");
    expect(await screen.findByText(/missing/)).toBeInTheDocument();
    expect(screen.getByText("GOOGLE_CLIENT_ID")).toBeInTheDocument();
    expect(screen.getByText("GOOGLE_CLIENT_SECRET")).toBeInTheDocument();
    expect(screen.getByText(START_URL)).toBeInTheDocument();
  });

  it("flags a connected account that does not match FOUNDER_EMAIL", async () => {
    installApiStub({
      calendarConnection: {
        provider: "google",
        account_email: "other@example.com",
        expected_account: "bill.nguyentonhoang@gmail.com",
        google_oauth_configured: true,
        oauth_start_url: START_URL,
        connected_at: "2026-09-10T09:00:00.000Z",
      },
    });
    renderApp("/calendar");
    expect(await screen.findByText(/other@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/flagged, not rejected/)).toBeInTheDocument();
    expect(screen.getByText(/bill\.nguyentonhoang@gmail\.com/)).toBeInTheDocument();
  });

  it("does not say unconnected when Google is linked but unread", async () => {
    const empty: CashCalendar = { from: "2026-09-01", to: "2026-09-30", days: [], busy_source: "none" };
    const unread: AvailabilityResponse = {
      busy: false,
      until: null,
      next_busy_start: null,
      source: "none",
      checked_at: derived.provenance.generated_at,
    };
    installApiStub({
      calendarConnection: {
        provider: "google",
        account_email: "bill.nguyentonhoang@gmail.com",
        expected_account: "bill.nguyentonhoang@gmail.com",
        google_oauth_configured: true,
        oauth_start_url: START_URL,
        connected_at: "2026-09-10T09:00:00.000Z",
      },
      availability: unread,
      calendar: empty,
    });
    renderApp("/calendar");
    expect(await screen.findByText(/Reading/)).toBeInTheDocument();
    expect(screen.getByText("Calendar unread — texts immediately")).toBeInTheDocument();
    expect(screen.queryByText(/No Google Calendar connected/)).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /^2026-09-02/ }));
    expect(await screen.findByText(/Could not read the founder calendar just now/)).toBeInTheDocument();
  });
});
