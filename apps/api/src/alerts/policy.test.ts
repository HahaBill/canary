/** Every branch of docs/AGENT_BEHAVIOR.md §1, and the order they are checked in. */
import type { Incident } from "@canary/shared";
import { buildMockDerived } from "@canary/shared/fixtures";
import { describe, expect, it } from "vitest";
import { decideNotify, deliverAfter, isDeferred } from "./policy.ts";

const NOW = "2026-09-14T12:00:00.000Z";
const BUSY_UNTIL = "2026-09-14T13:30:00.000Z";

const open = buildMockDerived().primary_incident!;
const incident = (patch: Partial<Incident> = {}): Incident => ({ ...open, ...patch });
const busy = { busy: true, until: BUSY_UNTIL };
const free = { busy: false, until: null };

describe("decideNotify", () => {
  it("sends a material, open, never-notified incident when the founder is free", () => {
    expect(decideNotify({ incident: incident(), availability: free, now: NOW })).toEqual({ send: true });
  });

  it("sends when there is no calendar signal at all", () => {
    expect(decideNotify({ incident: incident(), now: NOW })).toEqual({ send: true });
    expect(decideNotify({ incident: incident(), availability: null, now: NOW })).toEqual({ send: true });
  });

  it("stays quiet about an acknowledged or resolved incident (rule 3)", () => {
    expect(decideNotify({ incident: incident({ status: "ACKNOWLEDGED" }), availability: free, now: NOW })).toEqual({
      send: false,
      reason: "not_open",
    });
    expect(decideNotify({ incident: incident({ status: "RESOLVED" }), availability: free, now: NOW })).toEqual({
      send: false,
      reason: "not_open",
    });
  });

  it("stays quiet when the detectors did not call it material (rule 2)", () => {
    const immaterial = incident({ materiality: { material: false, rules_triggered: [], values: {} } });
    expect(decideNotify({ incident: immaterial, availability: free, now: NOW })).toEqual({ send: false, reason: "not_material" });
  });

  it("does not re-text an incident it has already notified about (rule 4)", () => {
    expect(decideNotify({ incident: incident({ last_notified: "2026-09-13T09:00:00.000Z" }), availability: free, now: NOW })).toEqual({
      send: false,
      reason: "already_notified",
    });
  });

  it("defers rather than drops when the founder is in a meeting, and says until when", () => {
    expect(decideNotify({ incident: incident(), availability: busy, now: NOW })).toEqual({
      send: false,
      reason: "calendar_busy",
      until: BUSY_UNTIL,
    });
  });

  it("defers to now when the busy block has no known end, so the next pass re-checks", () => {
    expect(decideNotify({ incident: incident(), availability: { busy: true, until: null }, now: NOW })).toEqual({
      send: false,
      reason: "calendar_busy",
      until: NOW,
    });
  });

  it("checks status before materiality before notification before the calendar", () => {
    const everything = incident({
      status: "RESOLVED",
      last_notified: "2026-09-13T09:00:00.000Z",
      materiality: { material: false, rules_triggered: [], values: {} },
    });
    expect(decideNotify({ incident: everything, availability: busy, now: NOW })).toEqual({ send: false, reason: "not_open" });
    expect(decideNotify({ incident: { ...everything, status: "OPEN" }, availability: busy, now: NOW })).toEqual({
      send: false,
      reason: "not_material",
    });
  });

  it("force bypasses every rule — that is what it is for", () => {
    const hopeless = incident({
      status: "RESOLVED",
      last_notified: "2026-09-13T09:00:00.000Z",
      materiality: { material: false, rules_triggered: [], values: {} },
    });
    expect(decideNotify({ incident: hopeless, force: true, availability: busy, now: NOW })).toEqual({ send: true });
  });
});

describe("deliverAfter / isDeferred", () => {
  it("queues a busy deferral until the end of the block", () => {
    const decision = decideNotify({ incident: incident(), availability: busy, now: NOW });
    expect(isDeferred(decision)).toBe(true);
    expect(deliverAfter(decision, NOW)).toBe(BUSY_UNTIL);
  });

  it("treats every other outcome as not deferred", () => {
    expect(isDeferred({ send: true })).toBe(false);
    expect(isDeferred({ send: false, reason: "not_open" })).toBe(false);
    expect(deliverAfter({ send: true }, NOW)).toBe(NOW);
    expect(deliverAfter({ send: false, reason: "already_notified" }, NOW)).toBe(NOW);
  });
});
