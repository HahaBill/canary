import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AvailabilityResponse, CalendarConnectionResponse } from "@canary/shared";
import { AvailabilityPill } from "@/components/calendar/AvailabilityPill.tsx";

const freeNone: AvailabilityResponse = {
  busy: false,
  until: null,
  next_busy_start: null,
  source: "none",
  checked_at: "2026-09-13T13:00:00.000Z",
};

const google: CalendarConnectionResponse = {
  provider: "google",
  account_email: "bill.nguyentonhoang@gmail.com",
  google_oauth_configured: true,
  oauth_start_url: "https://canary.test/oauth/google/start?secret=<WEBHOOK_SECRET>",
};

describe("AvailabilityPill", () => {
  it("says no calendar when nothing is linked", () => {
    render(<AvailabilityPill availability={freeNone} connection={{ ...google, provider: "none" }} loading={false} />);
    expect(screen.getByText("No calendar — texts immediately")).toBeInTheDocument();
  });

  it("says unread when Google is linked but the feed failed", () => {
    render(<AvailabilityPill availability={freeNone} connection={google} loading={false} />);
    expect(screen.getByText("Calendar unread — texts immediately")).toBeInTheDocument();
  });
});
