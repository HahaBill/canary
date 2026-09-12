/**
 * `POST /api/incidents/:id/schedule-review` — books 15 minutes on the founder's
 * calendar to look at an incident, and records a `canary` marker so the cash
 * calendar shows it.
 *
 * Privileged: it writes to a real calendar. Requires Google — an iCal feed is
 * read-only, so with only `CALENDAR_ICS_URL` configured the honest answer is 503
 * plus how to fix it, not a silently unbooked review.
 *
 * The slot is picked by `nextFreeSlot` from freeBusy data (no model chooses a
 * time), unless the caller names one.
 */
import type { ISODateTime } from "@canary/shared";
import { nextFreeSlot, DEFAULT_BUSINESS_DAYS, DEFAULT_LEAD_MINUTES, DEFAULT_REVIEW_MINUTES } from "../calendar/google/slots.ts";
import { reviewEventId, type ReviewEventRow } from "../calendar/review-events.ts";
import { baseUrl, jsonError, readJson, type CanaryApp } from "../context.ts";
import { incidentLink } from "../links.ts";
import { requestAuthorized } from "../security.ts";

/** Longest review Canary will book. A 15-minute default; an hour is a meeting, not a look. */
export const MAX_REVIEW_MINUTES = 60;
/** How far ahead `nextFreeSlot` searches — three business days, in calendar days of freeBusy. */
export const SLOT_SEARCH_DAYS = 7;

export interface ScheduleReviewResponse {
  ok: true;
  incident_id: string;
  event: {
    id: string;
    html_link: string | null;
    start: ISODateTime;
    end: ISODateTime;
    title: string;
  };
  /** The incident page the invite links to. Built by `buildAppPath`, never by a model. */
  url: string;
}

export function registerScheduleRoutes(app: CanaryApp): void {
  app.post("/api/incidents/:id/schedule-review", async (c) => {
    const auth = requestAuthorized(c.req.raw.headers, c.get("appEnv").WEBHOOK_SECRET);
    if (auth === "unconfigured") return jsonError(c, 503, "webhook_not_configured", "WEBHOOK_SECRET is not set.");
    if (auth === "unauthorized") return jsonError(c, 401, "unauthorized", "Missing or invalid x-canary-secret.");

    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_json", "Request body must be a JSON object.");

    const incidentId = c.req.param("id");
    const incident = await c.get("provider").getIncident(incidentId);
    if (!incident) return jsonError(c, 404, "incident_not_found", `No incident with id ${incidentId}.`);

    let durationMinutes = DEFAULT_REVIEW_MINUTES;
    if (body.duration_minutes !== undefined) {
      const requested = Number(body.duration_minutes);
      if (!Number.isInteger(requested) || requested < 5 || requested > MAX_REVIEW_MINUTES) {
        return jsonError(c, 400, "invalid_duration", `\`duration_minutes\` must be an integer between 5 and ${MAX_REVIEW_MINUTES}.`);
      }
      durationMinutes = requested;
    }

    let requestedStart: ISODateTime | null = null;
    if (body.start !== undefined) {
      if (typeof body.start !== "string" || !Number.isFinite(new Date(body.start).getTime())) {
        return jsonError(c, 400, "invalid_start", "`start` must be an ISO 8601 timestamp.");
      }
      requestedStart = new Date(body.start).toISOString();
    }

    const { provider: calendarProvider, google } = await c.get("calendarResolver").resolve();
    if (!google) {
      return jsonError(
        c,
        503,
        "google_not_connected",
        calendarProvider === "ics"
          ? "The iCal feed is read-only, so Canary cannot create events. Connect Google Calendar at /oauth/google/start to book reviews."
          : "Google Calendar is not connected. Connect it at /oauth/google/start to book reviews.",
      );
    }

    const now = c.get("now")();
    let start = requestedStart;
    if (!start) {
      const searchEnd = new Date(new Date(now).getTime() + SLOT_SEARCH_DAYS * 86_400_000).toISOString();
      const busy = await google.busyBetween(now, searchEnd);
      // Null means Google could not be asked. Booking blind risks double-booking the
      // founder, so say so instead (docs/AGENT_BEHAVIOR.md §4: never invent).
      if (busy === null) return jsonError(c, 502, "freebusy_unavailable", "Could not read availability from Google Calendar. Nothing was booked.");

      const slot = nextFreeSlot({
        now,
        busy,
        timeZone: google.timeZone,
        durationMinutes,
        leadMinutes: DEFAULT_LEAD_MINUTES,
        businessDays: DEFAULT_BUSINESS_DAYS,
      });
      if (!slot) {
        return jsonError(
          c,
          409,
          "no_free_slot",
          `No free ${durationMinutes}-minute slot in business hours over the next ${DEFAULT_BUSINESS_DAYS} business days. Pass \`start\` to choose one.`,
        );
      }
      start = slot.start;
    }

    const { url } = incidentLink(incident.id, baseUrl(c));
    const created = await google.createReviewEvent({ incident, appUrl: url, start, durationMinutes });
    if (!created.ok) return jsonError(c, 502, "calendar_write_failed", created.detail ?? "Google Calendar rejected the event.");

    const title = `Review scheduled — ${incident.title}`;
    const row: ReviewEventRow = {
      id: reviewEventId(incident.id, created.event.start),
      incident_id: incident.id,
      event_id: created.event.id,
      html_link: created.event.htmlLink,
      title,
      start_at: created.event.start,
      end_at: created.event.end,
      created_at: now,
    };
    await c.get("reviews")?.save(row);

    const response: ScheduleReviewResponse = {
      ok: true,
      incident_id: incident.id,
      event: { id: created.event.id, html_link: created.event.htmlLink, start: created.event.start, end: created.event.end, title },
      url,
    };
    return c.json(response);
  });
}
