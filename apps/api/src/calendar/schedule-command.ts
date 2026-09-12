/**
 * The `SCHEDULE` iMessage reply: "Booked 15 minutes on Monday at 9:15 AM to
 * review the AWS incident." plus the deep link.
 *
 * Lives here rather than in `messages.ts` because it is the only reply that
 * performs an action, and because `src/imessage/router.ts` is owned by another
 * workstream this cycle — the lead wires one `case "SCHEDULE"` line to this
 * function (see the workstream report).
 *
 * Every failure has an honest line. Canary never claims to have booked something
 * it did not (docs/AGENT_BEHAVIOR.md §4), and it never invents a time.
 */
import type { Incident, ISODateTime } from "@canary/shared";
import { driverEntity } from "../derive.ts";
import { displayName } from "../format.ts";
import { incidentLink } from "../links.ts";
import { DEFAULT_BUSINESS_DAYS, DEFAULT_LEAD_MINUTES, DEFAULT_REVIEW_MINUTES, nextFreeSlot } from "./google/slots.ts";
import type { GoogleCalendarProvider } from "./google/provider.ts";
import { reviewEventId, type ReviewEventStore } from "./review-events.ts";
import type { CalendarProviderName } from "./resolve.ts";

const DAY_MS = 86_400_000;
/** Same window the REST route searches. */
const SLOT_SEARCH_DAYS = 7;

export interface ScheduleReviewReplyInput {
  /** Which calendar is in use. Only `google` can be written to. */
  provider: CalendarProviderName;
  /** The Google provider, when connected. */
  calendar: GoogleCalendarProvider | null;
  incident: Incident | null;
  baseUrl: string;
  now: ISODateTime;
  durationMinutes?: number;
  /** Optional: records the booking so `/api/calendar` shows the marker too. */
  reviews?: ReviewEventStore | null;
}

/** "Monday at 9:15 AM", in the founder's own timezone — the only clock that matters to them. */
export function speakSlot(start: ISODateTime, timeZone: string): string {
  const at = new Date(start);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(at);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(at);
  return `${weekday} at ${time}`;
}

export async function scheduleReviewReply(input: ScheduleReviewReplyInput): Promise<string> {
  const { incident, calendar } = input;
  if (!incident) {
    return "Nothing is flagged right now, so there's nothing to review — spending is tracking with its baseline.";
  }
  if (input.provider !== "google" || !calendar) {
    return input.provider === "ics"
      ? "I can't book that — I can only read your calendar right now. Connecting Google Calendar to Canary would let me put the review on it."
      : "I can't book that — no calendar is connected to Canary yet.";
  }

  const durationMinutes = input.durationMinutes ?? DEFAULT_REVIEW_MINUTES;
  const searchEnd = new Date(new Date(input.now).getTime() + SLOT_SEARCH_DAYS * DAY_MS).toISOString();
  const busy = await calendar.busyBetween(input.now, searchEnd);
  if (busy === null) return "I couldn't reach your calendar just now, so I haven't booked anything. Try again in a minute.";

  const slot = nextFreeSlot({
    now: input.now,
    busy,
    timeZone: calendar.timeZone,
    durationMinutes,
    leadMinutes: DEFAULT_LEAD_MINUTES,
    businessDays: DEFAULT_BUSINESS_DAYS,
  });
  if (!slot) {
    return `You have nothing free for ${durationMinutes} minutes in business hours over the next ${DEFAULT_BUSINESS_DAYS} business days, so I haven't booked anything.`;
  }

  const { url } = incidentLink(incident.id, input.baseUrl);
  const created = await calendar.createReviewEvent({ incident, appUrl: url, start: slot.start, durationMinutes });
  if (!created.ok) return "I couldn't add the event to your calendar, so nothing is booked.";

  const title = `Review scheduled — ${incident.title}`;
  await input.reviews?.save({
    id: reviewEventId(incident.id, created.event.start),
    incident_id: incident.id,
    event_id: created.event.id,
    html_link: created.event.htmlLink,
    title,
    start_at: created.event.start,
    end_at: created.event.end,
    created_at: input.now,
  });

  // Same driver the alert text names, so the two messages describe one incident.
  const driver = displayName(driverEntity(incident));
  return [`Booked ${durationMinutes} minutes on ${speakSlot(created.event.start, calendar.timeZone)} to review the ${driver} incident.`, url].join("\n");
}
