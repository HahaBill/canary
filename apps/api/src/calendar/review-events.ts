/**
 * Reviews Canary has booked (migration 0005, table `review_events`).
 *
 * The event itself lives in Google Calendar; this table is Canary's own record
 * of it, so `/api/calendar` can show a `canary` marker on the day without asking
 * Google for a calendar it may no longer be connected to. One row per booked
 * review, keyed deterministically by incident + start, so re-booking the same
 * slot upserts instead of littering the day with duplicates.
 */
import { compareISODate, type CalendarEvent, type ISODate, type ISODateTime } from "@canary/shared";
import type { SqlDatabase } from "../data/d1.ts";

const COLUMNS = "id, incident_id, event_id, html_link, title, start_at, end_at, created_at";

export interface ReviewEventRow {
  id: string;
  incident_id: string;
  /** Google's event id, so a future version can update or cancel it. */
  event_id: string;
  html_link: string | null;
  title: string;
  start_at: ISODateTime;
  end_at: ISODateTime;
  created_at: ISODateTime;
}

/** Deterministic row id: the same review booked twice at the same time is one row. */
export function reviewEventId(incidentId: string, startAt: ISODateTime): string {
  return `${incidentId}|${startAt}`;
}

export class ReviewEventStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Best-effort, like the iMessage log: the Google event is the real artefact, and
   * a marker that failed to persist (migration 0005 not applied yet) must not turn
   * a successful booking into an error.
   */
  async save(row: ReviewEventRow): Promise<boolean> {
    try {
      await this.db
        .prepare(
          `INSERT INTO review_events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ` +
            "ON CONFLICT(id) DO UPDATE SET event_id = excluded.event_id, html_link = excluded.html_link, title = excluded.title, " +
            "start_at = excluded.start_at, end_at = excluded.end_at, created_at = excluded.created_at",
        )
        .bind(row.id, row.incident_id, row.event_id, row.html_link, row.title, row.start_at, row.end_at, row.created_at)
        .run();
      return true;
    } catch (err) {
      console.warn(JSON.stringify({ msg: "review_event_save_failed", error: err instanceof Error ? err.message : String(err) }));
      return false;
    }
  }

  /**
   * Every booked review, oldest first. The date filter is applied in TypeScript
   * for the same reason `listPendingAlerts` does it: a handful of rows, and a
   * boring statement shape is what keeps these tests out of workerd.
   *
   * Empty on failure — `/api/calendar` is the one surface that must not 500
   * because an additive migration is a deploy behind.
   */
  async list(): Promise<ReviewEventRow[]> {
    let results: Array<Record<string, unknown>> = [];
    try {
      results = (await this.db.prepare(`SELECT ${COLUMNS} FROM review_events ORDER BY start_at ASC`).all<Record<string, unknown>>()).results ?? [];
    } catch (err) {
      console.warn(JSON.stringify({ msg: "review_events_list_failed", error: err instanceof Error ? err.message : String(err) }));
      return [];
    }
    return results.map((row) => ({
      id: String(row.id),
      incident_id: String(row.incident_id),
      event_id: String(row.event_id ?? ""),
      html_link: row.html_link === null || row.html_link === undefined ? null : String(row.html_link),
      title: String(row.title ?? ""),
      start_at: String(row.start_at),
      end_at: String(row.end_at),
      created_at: String(row.created_at),
    }));
  }
}

/**
 * Booked reviews → `canary` calendar markers inside `[from, to]`.
 *
 * `date` is the UTC day of the start, the same convention `busyEvents` uses, so
 * the marker lands on the same row of the grid as the busy block it sits beside.
 */
export function reviewCalendarEvents(rows: readonly ReviewEventRow[], from: ISODate, to: ISODate): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const row of rows) {
    const date = row.start_at.slice(0, 10) as ISODate;
    if (compareISODate(date, from) < 0 || compareISODate(date, to) > 0) continue;
    out.push({
      id: `review_${row.event_id || row.id.replace(/[^a-zA-Z0-9]+/g, "_")}`,
      kind: "canary",
      date,
      start: row.start_at,
      end: row.end_at,
      title: row.title,
      incident_id: row.incident_id,
    });
  }
  return out;
}

/** Null when D1 is not bound (unit tests, `wrangler dev` without D1). */
export function reviewEventStoreFor(db: SqlDatabase | undefined): ReviewEventStore | null {
  return db ? new ReviewEventStore(db) : null;
}
