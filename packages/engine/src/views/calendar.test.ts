import { describe, expect, it } from "vitest";
import { buildMockDerived, SAMPLE_HISTORY_END, SAMPLE_HISTORY_START } from "@canary/shared/fixtures";
import { sumCents, type CalendarEvent, type Incident, type RecurringSeries } from "@canary/shared";
import { buildSampleLedger } from "../test-support.ts";
import { buildDemoLedger } from "./demo-ledger.testkit.ts";
import { buildCashCalendarEvents } from "./calendar.ts";
import { projectRecurring } from "./recurring.ts";

const KIND_RANK: Record<string, number> = { actual: 0, expected: 1, canary: 2, busy: 3 };

/** Both demo incidents, on the same 20-week grid the generator uses. */
const MOCK_INCIDENTS: Incident[] = buildMockDerived().incidents;

function eventsOf(events: CalendarEvent[], kind: CalendarEvent["kind"]): CalendarEvent[] {
  return events.filter((e) => e.kind === kind);
}

describe("buildCashCalendarEvents — actual events", () => {
  const ledger = buildSampleLedger();
  const events = buildCashCalendarEvents({
    ledger,
    incidents: [],
    recurring: [],
    from: SAMPLE_HISTORY_START,
    to: SAMPLE_HISTORY_END,
  });
  const actual = eventsOf(events, "actual");

  it("emits one event per cash movement and per card purchase", () => {
    // Everything except the dropped pending row and the card leg of the settlement.
    const expected = ledger.transactions.filter((t) => !t.dropped && t.id !== "t011");
    expect(actual.map((e) => e.id).sort()).toEqual(expected.map((t) => `act_${t.id}`).sort());
    expect(actual.map((e) => e.id)).not.toContain("act_t014");
  });

  it("carries the signed amount, the entity and the category", () => {
    const aws = actual.find((e) => e.id === "act_t001")!;
    expect(aws).toMatchObject({
      kind: "actual",
      date: "2026-08-17",
      title: "AWS",
      amount_cents: -1_200_000,
      entity: "aws",
      category: "CLOUD_INFRASTRUCTURE",
    });
    expect(actual.find((e) => e.id === "act_t003")!.amount_cents).toBe(2_500_000);
  });

  it("titles vendors the way a founder reads them", () => {
    expect(actual.find((e) => e.id === "act_t005")!.title).toBe("DoorDash");
    expect(actual.find((e) => e.id === "act_t002")!.title).toBe("Gusto Payroll");
    expect(actual.find((e) => e.id === "act_t012")!.title).toBe("Ashby");
  });

  it("keeps a card purchase on its own date, separate from the settlement", () => {
    const purchase = actual.find((e) => e.id === "act_t004")!;
    const settlement = actual.find((e) => e.id === "act_t010")!;
    expect(purchase.date).toBe("2026-08-20");
    expect(settlement.date).toBe("2026-08-26");
    expect(settlement.amount_cents).toBe(-63_000);
  });

  it("nets both legs of an internal transfer to zero on the day", () => {
    const legs = actual.filter((e) => e.entity === "internal_transfer");
    expect(legs).toHaveLength(2);
    expect(sumCents(legs.map((e) => e.amount_cents!))).toBe(0);
    expect(new Set(legs.map((e) => e.date)).size).toBe(1);
  });

  it("honours the range", () => {
    const narrow = buildCashCalendarEvents({
      ledger,
      incidents: [],
      recurring: [],
      from: "2026-09-01",
      to: "2026-09-04",
    });
    expect(narrow.map((e) => e.id)).toEqual(["act_t015", "act_t016", "act_t017"]);
  });
});

describe("buildCashCalendarEvents — expected events", () => {
  const ledger = buildSampleLedger();
  const recurring: RecurringSeries[] = [
    {
      entity: "aws",
      category: "CLOUD_INFRASTRUCTURE",
      cadence: "weekly",
      typical_amount_cents: -1_400_000,
      observations: 4,
      last_seen: "2026-09-08",
      next_dates: ["2026-09-15", "2026-09-22", "2026-09-29"],
    },
  ];
  const events = buildCashCalendarEvents({ ledger, incidents: [], recurring, from: "2026-09-14", to: "2026-09-25" });

  it("emits one event per projected date inside the range", () => {
    expect(eventsOf(events, "expected").map((e) => e.id)).toEqual(["exp_aws_2026-09-15", "exp_aws_2026-09-22"]);
  });

  it("labels the projection and says what it rests on", () => {
    expect(eventsOf(events, "expected")[0]).toEqual({
      id: "exp_aws_2026-09-15",
      kind: "expected",
      date: "2026-09-15",
      title: "Expected: AWS",
      amount_cents: -1_400_000,
      entity: "aws",
      category: "CLOUD_INFRASTRUCTURE",
      cadence: "weekly",
      confidence_n: 4,
    });
  });
});

describe("buildCashCalendarEvents — canary markers", () => {
  const { ledger } = buildDemoLedger();
  const events = buildCashCalendarEvents({
    ledger,
    incidents: MOCK_INCIDENTS,
    recurring: [],
    from: ledger.history_start,
    to: ledger.history_end,
  });
  const canary = eventsOf(events, "canary");
  const [burnShift, oneOff] = MOCK_INCIDENTS;

  it("marks the change point with the incident it belongs to", () => {
    const marker = canary.find((e) => e.id === `cny_change_point_${burnShift!.id}`)!;
    expect(marker).toMatchObject({
      date: burnShift!.estimated_change_point!,
      title: `Change point — ${burnShift!.title}`,
      incident_id: burnShift!.id,
      incident_type: "BURN_RATE_SHIFT",
    });
    expect(marker.amount_cents).toBeUndefined();
  });

  it("marks the alarm the founder was texted about", () => {
    expect(canary.find((e) => e.id === `cny_alarm_${burnShift!.id}`)).toMatchObject({
      date: burnShift!.alarm_date!,
      title: "Canary alarm",
      incident_id: burnShift!.id,
    });
  });

  it("names the vendor on a one-off flag", () => {
    expect(canary.find((e) => e.id === `cny_one_off_${oneOff!.id}`)).toMatchObject({
      date: oneOff!.alarm_date!,
      title: "One-off flagged: Figma",
      entity: "figma",
      incident_id: oneOff!.id,
      incident_type: "ONE_OFF_VENDOR_PAYMENT",
    });
  });

  it("emits one marker per incident date and nothing for a null date", () => {
    expect(canary).toHaveLength(3);
    expect(oneOff!.estimated_change_point).toBeNull();
    expect(canary.filter((e) => e.incident_id === oneOff!.id)).toHaveLength(1);
  });

  it("drops markers outside the range", () => {
    const all = eventsOf(
      buildCashCalendarEvents({ ledger, incidents: MOCK_INCIDENTS, recurring: [], from: ledger.history_start, to: ledger.history_end }),
      "canary",
    );
    expect(all.length).toBeGreaterThan(1);

    // Cut the range at the earliest marker: everything after it must drop out.
    const earliest = all.map((e) => e.date).sort()[0]!;
    const narrow = buildCashCalendarEvents({
      ledger,
      incidents: MOCK_INCIDENTS,
      recurring: [],
      from: ledger.history_start,
      to: earliest,
    });

    expect(eventsOf(narrow, "canary").length).toBeLessThan(all.length);
    expect(eventsOf(narrow, "canary").every((e) => e.date <= earliest)).toBe(true);
  });
});

describe("buildCashCalendarEvents — ordering and identity", () => {
  const { ledger } = buildDemoLedger();
  const recurring = projectRecurring(ledger, { horizonEnd: "2026-10-31" });
  const events = buildCashCalendarEvents({
    ledger,
    incidents: MOCK_INCIDENTS,
    recurring,
    from: ledger.history_start,
    to: "2026-10-31",
  });

  it("sorts by date, then actual before expected before canary, then id", () => {
    const keys = events.map((e) => `${e.date}|${KIND_RANK[e.kind]}|${e.id}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("gives every event a unique id", () => {
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("puts actuals inside history and expectations after it", () => {
    for (const e of eventsOf(events, "actual")) expect(e.date <= ledger.history_end).toBe(true);
    for (const e of eventsOf(events, "expected")) expect(e.date > ledger.history_end).toBe(true);
    expect(eventsOf(events, "expected").length).toBeGreaterThan(20);
  });

  it("never emits busy blocks — the API owns the founder's calendar", () => {
    expect(eventsOf(events, "busy")).toEqual([]);
  });

  it("only reports money the ledger reported", () => {
    const actualByDate = new Map<string, number>();
    for (const e of eventsOf(events, "actual")) {
      actualByDate.set(e.date, (actualByDate.get(e.date) ?? 0) + e.amount_cents!);
    }
    for (const [date, net] of actualByDate) {
      const fromLedger = sumCents(
        ledger.transactions
          .filter((t) => !t.dropped && t.date === date && (t.counts_in_cash || (t.counts_in_burn && !t.counts_in_cash)))
          .map((t) => t.amount_cents),
      );
      expect(net).toBe(fromLedger);
    }
  });

  it("is byte-identical across runs", () => {
    const again = buildCashCalendarEvents({
      ledger: buildDemoLedger().ledger,
      incidents: MOCK_INCIDENTS,
      recurring: projectRecurring(buildDemoLedger().ledger, { horizonEnd: "2026-10-31" }),
      from: ledger.history_start,
      to: "2026-10-31",
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(events));
  });
});
