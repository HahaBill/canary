import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMockDerived } from "@canary/shared/fixtures";
import { resetMockSnapshot } from "@/api/mock.ts";
import { clearApiCache } from "@/api/useDerived.ts";
import { formatDateMedium, WEEKDAY_LABELS } from "@/lib/format.ts";
import { installApiStub, renderApp, setViewport, type RecordedRequest } from "@/test-utils.tsx";

const derived = buildMockDerived();
/** The demo clock is the end of history, so "today" is 2026-09-13. */
const today = derived.provenance.end_date;

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

  it("opens on the month containing the end of history and asks for exactly that range", async () => {
    renderApp("/calendar");

    // The grid renders once the calendar range resolves.
    await screen.findByRole("button", { name: /^2026-09-01/ });
    expect(screen.getByRole("heading", { name: "September 2026" })).toBeInTheDocument();
    expect(screen.getByText(`as of ${formatDateMedium(today)}`)).toBeInTheDocument();

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
    // 2026-09-01 is a Tuesday, so the grid starts on Aug 31 and runs 5 weeks.
    const dayCells = screen.getAllByRole("button", { name: /^2026-\d{2}-\d{2}, / });
    expect(dayCells).toHaveLength(35);
    expect(dayCells[0]).toHaveAccessibleName(/^2026-08-31/);
  });

  it("shows posted, expected and busy chips, and the availability pill", async () => {
    renderApp("/calendar");
    await screen.findByRole("button", { name: /^2026-09-01/ });

    // Posted: the last week of history. Expected: projections past its end.
    const posted = screen.getByRole("button", { name: /^2026-09-07/ });
    expect(within(posted).getByText("AWS")).toBeInTheDocument();

    const projected = screen.getByRole("button", { name: /^2026-09-14/ });
    expect(within(projected).getAllByText("expected").length).toBeGreaterThan(0);

    const busyOnly = screen.getByRole("button", { name: /^2026-09-02/ });
    expect(within(busyOnly).getByText("Busy")).toBeInTheDocument();

    expect(screen.getByText("Founder free")).toBeInTheDocument();
  });

  it("shows Canary markers in the month the detector fired, never behind +n more", async () => {
    renderApp("/calendar");
    await screen.findByRole("button", { name: /^2026-09-01/ });

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(await screen.findByRole("heading", { name: "August 2026" })).toBeInTheDocument();

    // 2026-08-03 also holds a full week of posted charges and a busy block.
    const oneOffDay = await screen.findByRole("button", { name: /^2026-08-03/ });
    expect(within(oneOffDay).getByText(derived.one_off_incident!.title)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(await screen.findByRole("heading", { name: "July 2026" })).toBeInTheDocument();
    const changePoint = derived.primary_incident!.estimated_change_point!;
    const changePointDay = await screen.findByRole("button", { name: new RegExp(`^${changePoint}`) });
    expect(within(changePointDay).getByText(/Change point/)).toBeInTheDocument();
  });

  it("returns to the demo clock with Today", async () => {
    renderApp("/calendar");
    await screen.findByRole("button", { name: /^2026-09-01/ });

    expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await screen.findByRole("heading", { name: "August 2026" });

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(await screen.findByRole("heading", { name: "September 2026" })).toBeInTheDocument();
  });

  it("opens a day panel grouped by kind with links out", async () => {
    renderApp("/calendar");
    await screen.findByRole("button", { name: /^2026-09-01/ });

    fireEvent.click(screen.getByRole("button", { name: /^2026-09-07/ }));

    const panel = await screen.findByRole("dialog");
    expect(within(panel).getByText(formatDateMedium("2026-09-07"))).toBeInTheDocument();
    expect(within(panel).getByText("Posted")).toBeInTheDocument();
    expect(within(panel).getByText("Calendar")).toBeInTheDocument();
    expect(within(panel).getAllByRole("link", { name: "View in ledger" })[0]).toHaveAttribute(
      "href",
      "/ledger?focus=vendor:aws",
    );
  });
});
