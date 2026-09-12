/**
 * Cash calendar events: what happened, what history says to expect, and what
 * Canary flagged.
 *
 *   actual    one event per settled/pending cash movement or card purchase
 *   expected  one per projected recurring date (ESTIMATE — "from history")
 *   canary    change point, alarm, one-off flag
 *
 * `busy` events are not built here: the founder's calendar feed is private and
 * lives in the API, which merges those blocks in.
 */
import {
  compareISODate,
  type BuildCashCalendarEvents,
  type CalendarEvent,
  type CalendarEventKind,
  type ISODate,
  type LedgerTransaction,
} from "@canary/shared";
import { entityDisplayName } from "./labels.ts";
import { isCardPurchase } from "./sections.ts";

const KIND_ORDER: Record<CalendarEventKind, number> = { actual: 0, expected: 1, canary: 2, busy: 3 };

export const buildCashCalendarEvents: BuildCashCalendarEvents = ({
  ledger,
  incidents,
  recurring,
  from,
  to,
}): CalendarEvent[] => {
  const events: CalendarEvent[] = [];
  const inRange = (date: ISODate): boolean =>
    compareISODate(date, from) >= 0 && compareISODate(date, to) <= 0;

  for (const tx of ledger.transactions) {
    if (!isCalendarActual(tx) || !inRange(tx.date)) continue;
    events.push({
      id: `act_${tx.id}`,
      kind: "actual",
      date: tx.date,
      title: entityDisplayName(tx.merchant_normalized),
      amount_cents: tx.amount_cents,
      entity: tx.merchant_normalized,
      category: tx.category,
    });
  }

  for (const series of recurring) {
    for (const date of series.next_dates) {
      if (!inRange(date)) continue;
      events.push({
        id: `exp_${series.entity}_${date}`,
        kind: "expected",
        date,
        title: `Expected: ${entityDisplayName(series.entity)}`,
        amount_cents: series.typical_amount_cents,
        entity: series.entity,
        category: series.category,
        cadence: series.cadence,
        confidence_n: series.observations,
      });
    }
  }

  for (const incident of incidents) {
    const changePoint = incident.estimated_change_point;
    if (changePoint && inRange(changePoint)) {
      events.push({
        id: `cny_change_point_${incident.id}`,
        kind: "canary",
        date: changePoint,
        title: `Change point — ${incident.title}`,
        incident_id: incident.id,
        incident_type: incident.type,
      });
    }
    const alarm = incident.alarm_date;
    if (alarm && inRange(alarm)) {
      // One marker per incident per date: a one-off's alarm IS the flag, so it
      // is titled as one rather than repeated as a generic alarm.
      const oneOff = incident.type === "ONE_OFF_VENDOR_PAYMENT";
      events.push({
        id: `cny_${oneOff ? "one_off" : "alarm"}_${incident.id}`,
        kind: "canary",
        date: alarm,
        title: oneOff ? `One-off flagged: ${entityDisplayName(incident.entity)}` : "Canary alarm",
        entity: oneOff ? incident.entity : undefined,
        incident_id: incident.id,
        incident_type: incident.type,
      });
    }
  }

  return events.sort(compareEvents);
};

/**
 * Everything that moved money on the calendar: cash movements plus card
 * purchases (which move burn on their own date and cash only when the card is
 * settled — that settlement is its own cash event).
 */
function isCalendarActual(tx: LedgerTransaction): boolean {
  if (tx.dropped) return false;
  return tx.counts_in_cash || isCardPurchase(tx);
}

function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  const byDate = compareISODate(a.date, b.date);
  if (byDate !== 0) return byDate;
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (byKind !== 0) return byKind;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
