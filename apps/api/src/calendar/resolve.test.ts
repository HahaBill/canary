/** Resolution order: Google when connected, else the iCal feed, else nothing — and the fallbacks that keep an alert from being blocked. */
import { beforeEach, describe, expect, it } from "vitest";
import { buildVariables } from "../app.ts";
import type { Env } from "../env.ts";
import { FakeD1 } from "../test/fake-d1.ts";
import { connectGoogle, FIXED_NOW, GOOGLE_TEST_ENV, TEST_ENV } from "../test/harness.ts";
import { clearGoogleCalendarCache } from "./google/provider.ts";
import { clearGoogleTokenCache } from "./google/tokens.ts";
import { createCalendarResolver, googleConfigured } from "./resolve.ts";

const ICS_URL = "https://calendar.google.com/calendar/ical/founder/private-abc/basic.ics";

function env(extra: Partial<Env> = {}): Env {
  return { ...TEST_ENV, ...GOOGLE_TEST_ENV, ...extra } as unknown as Env;
}

function resolver(appEnv: Env, db?: FakeD1) {
  return createCalendarResolver({ appEnv, db, now: () => FIXED_NOW });
}

beforeEach(() => {
  clearGoogleTokenCache();
  clearGoogleCalendarCache();
});

describe("google > ics > none", () => {
  it("prefers Google over a configured iCal feed", async () => {
    const db = new FakeD1();
    await connectGoogle(db);
    const resolution = await resolver(env({ CALENDAR_ICS_URL: ICS_URL }), db).resolve();
    expect(resolution.provider).toBe("google");
    expect(resolution.google).not.toBeNull();
    expect(resolution.feed).toBe(resolution.google);
  });

  it("uses the iCal feed when Google is not connected, and offers no writable calendar", async () => {
    const resolution = await resolver(env({ CALENDAR_ICS_URL: ICS_URL }), new FakeD1()).resolve();
    expect(resolution.provider).toBe("ics");
    expect(resolution.google).toBeNull();
    expect(resolution.connection).toMatchObject({
      provider: "ics",
      google_oauth_configured: true,
      oauth_start_url: "https://canary.test/oauth/google/start?secret=<WEBHOOK_SECRET>",
    });
  });

  it("surfaces FOUNDER_EMAIL as expected_account on every connection body", async () => {
    const resolution = await resolver(
      env({ FOUNDER_EMAIL: "bill.nguyentonhoang@gmail.com", GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }),
    ).resolve();
    expect(resolution.connection).toEqual({
      provider: "none",
      google_oauth_configured: false,
      expected_account: "bill.nguyentonhoang@gmail.com",
      oauth_start_url: "https://canary.test/oauth/google/start?secret=<WEBHOOK_SECRET>",
    });
  });

  it("resolves to none with neither, and reports free so an alert is never blocked", async () => {
    const r = resolver(env({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }));
    expect((await r.resolve()).provider).toBe("none");
    expect(r.oauthStore).toBeNull();
    expect(await r.feed.isBusyAt(FIXED_NOW)).toEqual({ busy: false, until: null, next_busy_start: null, source: "none" });
  });

  it("cannot resolve to Google without D1 to read the row from", async () => {
    expect((await resolver(env()).resolve()).provider).toBe("none");
    expect(googleConfigured(env())).toBe(false);
  });

  it("cannot resolve to Google without an OAuth client, even with a stored row", async () => {
    const db = new FakeD1();
    await connectGoogle(db);
    const appEnv = env({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, CALENDAR_ICS_URL: ICS_URL });
    expect((await resolver(appEnv, db).resolve()).provider).toBe("ics");
    expect(googleConfigured(appEnv, db)).toBe(false);
  });

  it("falls back when the stored row is revoked", async () => {
    const db = new FakeD1();
    await connectGoogle(db);
    const store = resolver(env(), db).oauthStore!;
    await store.markRevoked("2026-09-13T09:00:00.000Z");
    const resolution = await resolver(env({ CALENDAR_ICS_URL: ICS_URL }), db).resolve();
    expect(resolution.provider).toBe("ics");
    expect(resolution.google).toBeNull();
    expect(resolution.connection.revoked_at).toBe("2026-09-13T09:00:00.000Z");
  });

  it("falls back when the table is missing (migration 0005 a deploy behind)", async () => {
    const db = new FakeD1({ rejectTables: ["google_oauth"] });
    expect((await resolver(env({ CALENDAR_ICS_URL: ICS_URL }), db).resolve()).provider).toBe("ics");
  });
});

describe("the lazy feed", () => {
  it("resolves once, however many times it is asked", async () => {
    const db = new FakeD1();
    await connectGoogle(db);
    const r = resolver(env(), db);
    const before = db.executed.length;
    const [a, b] = await Promise.all([r.resolve(), r.resolve()]);
    expect(a).toBe(b);
    // One SELECT for the row; the second call is memoized.
    expect(db.executed.length - before).toBe(1);
  });

  it("reports itself configured when either calendar could answer", () => {
    expect(resolver(env({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined })).feed.configured).toBe(false);
    expect(resolver(env({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, CALENDAR_ICS_URL: ICS_URL })).feed.configured).toBe(true);
    expect(resolver(env(), new FakeD1()).feed.configured).toBe(true);
  });

  it("delegates fetchEvents to whichever calendar was chosen", async () => {
    const resolution = resolver(env({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }));
    expect(await resolution.feed.fetchEvents("2026-09-14", "2026-09-14")).toEqual({ events: [], source: "none" });
  });
});

describe("buildVariables", () => {
  it("hands routes the resolver's feed by default", () => {
    const variables = buildVariables(env(), {});
    expect(variables.calendar).toBe(variables.calendarResolver.feed);
  });

  it("lets a test override the feed without losing the resolver", () => {
    const stub = { configured: true, fetchEvents: async () => ({ events: [], source: "none" as const }), isBusyAt: async () => ({ busy: false, until: null, next_busy_start: null, source: "none" as const }) };
    const variables = buildVariables(env(), { calendar: stub });
    expect(variables.calendar).toBe(stub);
    expect(variables.calendarResolver).toBeDefined();
  });

  it("wires the review-event store only when D1 is bound", () => {
    expect(buildVariables(env(), {}).reviews).toBeNull();
    expect(buildVariables(env(), { db: new FakeD1() }).reviews).not.toBeNull();
  });
});
