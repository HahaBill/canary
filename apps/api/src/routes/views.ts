/**
 * The ledger sheet, founder availability calendar and Needs Review.
 *
 * Read routes are public (PRD §31). `POST /api/classifications/override` is the
 * Needs Review Assign write — public on the demo, unlike alerts / webhook / OAuth.
 */
import {
  CATEGORIES,
  daysBetween,
  type AvailabilityResponse,
  type CalendarResponse,
  type Category,
  type ClassificationOverride,
  type ClassificationOverrideResponse,
  type ISODate,
  type LedgerCellResponse,
  type LedgerFilterQueryRequest,
  type LedgerFilterQueryResponse,
  type LedgerResponse,
  type NeedsReviewResponse,
  type PivotGranularity,
} from "@canary/shared";
import { interpretLedgerQuery } from "../ledger/interpret.ts";
import { buildCashCalendar, MAX_CALENDAR_SPAN_DAYS } from "../calendar/cash-calendar.ts";
import { reviewCalendarEvents } from "../calendar/review-events.ts";
import { jsonError, readJson, type CanaryApp, type CanaryContext } from "../context.ts";
import { PIVOT_GRANULARITIES } from "../data/mock-views.ts";

/** Categories a reviewer may choose. NEEDS_REVIEW is the state they are leaving, not a destination. */
export const OVERRIDE_CATEGORIES = CATEGORIES.filter((c) => c !== "NEEDS_REVIEW");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseGranularity(raw: string | undefined): PivotGranularity | null {
  if (raw === undefined || raw === "") return "month";
  return (PIVOT_GRANULARITIES as readonly string[]).includes(raw) ? (raw as PivotGranularity) : null;
}

/** Calendar-month bounds for the day `date` falls in. */
function monthRange(date: ISODate): { from: ISODate; to: ISODate } {
  const [year, month] = date.split("-").map(Number) as [number, number];
  return { from: `${date.slice(0, 7)}-01`, to: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10) };
}

export function registerViewRoutes(app: CanaryApp): void {
  app.get("/api/ledger", async (c) => {
    const granularity = parseGranularity(c.req.query("granularity"));
    if (!granularity) return jsonError(c, 400, "invalid_granularity", `\`granularity\` must be one of: ${PIVOT_GRANULARITIES.join(", ")}.`);
    const body: LedgerResponse = { pivot: await c.get("provider").getLedgerPivot(granularity) };
    return c.json(body);
  });

  app.get("/api/ledger/cell", async (c) => {
    const rowId = c.req.query("row_id")?.trim() ?? "";
    const periodKey = c.req.query("period_key")?.trim() ?? "";
    if (!rowId) return jsonError(c, 400, "invalid_row_id", "`row_id` is required.");
    if (!periodKey) return jsonError(c, 400, "invalid_period_key", "`period_key` is required.");

    const granularity = parseGranularity(c.req.query("granularity"));
    if (!granularity) return jsonError(c, 400, "invalid_granularity", `\`granularity\` must be one of: ${PIVOT_GRANULARITIES.join(", ")}.`);

    const detail = await c.get("provider").getLedgerCell(rowId, periodKey, granularity);
    if (!detail) return jsonError(c, 404, "cell_not_found", `No ${granularity} cell for row ${rowId} in period ${periodKey}.`);
    const body: LedgerCellResponse = { detail };
    return c.json(body);
  });

  app.post("/api/ledger/query", async (c) => {
    const body = (await readJson(c)) as LedgerFilterQueryRequest | null;
    if (!body || typeof body.q !== "string") return jsonError(c, 400, "invalid_query", "`q` must be a string.");
    const granularity = parseGranularity(typeof body.granularity === "string" ? body.granularity : undefined);
    if (!granularity) return jsonError(c, 400, "invalid_granularity", `\`granularity\` must be one of: ${PIVOT_GRANULARITIES.join(", ")}.`);
    const pivot = await c.get("provider").getLedgerPivot(granularity);
    const response: LedgerFilterQueryResponse = await interpretLedgerQuery(body.q, pivot, c.get("llm"));
    return c.json(response);
  });

  app.get("/api/calendar", async (c) => {
    const requestedFrom = c.req.query("from")?.trim() ?? "";
    const requestedTo = c.req.query("to")?.trim() ?? "";
    for (const [name, value] of [["from", requestedFrom], ["to", requestedTo]] as const) {
      if (value && !ISO_DATE.test(value)) return jsonError(c, 400, "invalid_date", `\`${name}\` must be YYYY-MM-DD.`);
    }

    // Default to the month the notification clock is in — this page is about
    // when Canary may text, not the ledger's last posted week.
    const fallback = monthRange(c.get("now")().slice(0, 10));
    const from = requestedFrom || fallback.from;
    const to = requestedTo || fallback.to;
    if (daysBetween(from, to) < 0) return jsonError(c, 400, "invalid_range", "`from` must not be after `to`.");
    if (daysBetween(from, to) + 1 > MAX_CALENDAR_SPAN_DAYS) {
      return jsonError(c, 400, "range_too_large", `Request at most ${MAX_CALENDAR_SPAN_DAYS} days.`);
    }

    // Reviews Canary booked live in D1 (the event itself is on the founder's
    // Google Calendar). Ledger actuals / projections stay off this surface —
    // this calendar is only "may Canary text right now".
    const [feed, reviews] = await Promise.all([
      c.get("calendar").fetchEvents(from, to),
      c.get("reviews")?.list() ?? Promise.resolve([]),
    ]);
    const body: CalendarResponse = {
      calendar: buildCashCalendar({
        from,
        to,
        events: reviewCalendarEvents(reviews, from, to),
        busy: feed.events,
        busySource: feed.source,
        showTitles: c.get("appEnv").CALENDAR_SHOW_TITLES === "1",
      }),
    };
    return c.json(body);
  });

  app.get("/api/availability", async (c) => {
    const now = c.get("now")();
    const status = await c.get("calendar").isBusyAt(now);
    const body: AvailabilityResponse = {
      busy: status.busy,
      until: status.until,
      next_busy_start: status.next_busy_start,
      source: status.source,
      checked_at: now,
    };
    return c.json(body);
  });

  app.get("/api/needs-review", async (c) => {
    const body = await needsReviewBody(c);
    return c.json(body);
  });

  app.post("/api/classifications/override", async (c) => {
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_json", "Request body must be a JSON object.");

    const transactionId = typeof body.transaction_id === "string" ? body.transaction_id.trim() : "";
    if (!transactionId) return jsonError(c, 400, "invalid_transaction_id", "`transaction_id` is required.");

    const category = body.category;
    if (typeof category !== "string" || !(OVERRIDE_CATEGORIES as readonly string[]).includes(category)) {
      return jsonError(c, 400, "invalid_category", `\`category\` must be one of: ${OVERRIDE_CATEGORIES.join(", ")}.`);
    }
    if (body.note !== undefined && typeof body.note !== "string") return jsonError(c, 400, "invalid_note", "`note` must be a string.");

    const provider = c.get("provider");
    const item = (await provider.getNeedsReview()).find((i) => i.transaction_id === transactionId);
    if (!item) return jsonError(c, 404, "transaction_not_found", `No Needs Review transaction with id ${transactionId}.`);

    const override: ClassificationOverride = {
      transaction_id: transactionId,
      merchant_normalized: item.merchant_normalized,
      category: category as Category,
      apply_to_merchant: body.apply_to_merchant === true,
      ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.trim() } : {}),
      created_at: c.get("now")(),
    };

    await c.get("store")?.saveClassificationOverride(override);
    await provider.applyClassificationOverride(override);
    // The count comes from the same reconciliation the GET uses, so the two can never disagree.
    const { count } = await needsReviewBody(c);
    const response: ClassificationOverrideResponse = { override, needs_review_count: count };
    return c.json(response);
  });
}

/**
 * Count and outflow are recomputed from the items still outstanding, so an
 * override moves all three together (the derived object's own count is a pipeline
 * snapshot that predates any review).
 *
 * D1 is the durable record: the provider's own memory of a review is per isolate,
 * so a cold isolate would otherwise resurrect an item a founder already
 * categorised. Filtering by the stored overrides here is what makes a review stick.
 */
async function needsReviewBody(c: CanaryContext): Promise<NeedsReviewResponse> {
  const overrides = (await c.get("store")?.listClassificationOverrides()) ?? [];
  const reviewed = new Set(overrides.map((o) => o.transaction_id));
  const reviewedMerchants = new Set(overrides.filter((o) => o.apply_to_merchant).map((o) => o.merchant_normalized));
  const items = (await c.get("provider").getNeedsReview()).filter(
    (item) => !reviewed.has(item.transaction_id) && !reviewedMerchants.has(item.merchant_normalized),
  );
  return {
    count: items.length,
    outflow_cents: items.reduce((total, item) => total + Math.abs(item.amount_cents), 0),
    items,
    overrides,
  };
}
