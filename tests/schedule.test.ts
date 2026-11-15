import { describe, expect, it } from "vitest";
import { doseId, planOccurrences, resolveLocalTime, type ScheduleRule } from "../src/server/services/schedule.js";

const rule = (over: Partial<ScheduleRule> = {}): ScheduleRule => ({
  times: ["08:00"],
  startDate: "2026-01-01",
  endDate: null,
  scheduleEffectiveFrom: new Date("2000-01-01T00:00:00Z"),
  ...over,
});
const iso = (d: Date) => d.toISOString();

describe("resolveLocalTime", () => {
  it("converts local time in the profile's zone to UTC", () => {
    expect(resolveLocalTime("2026-11-15", "08:00", "Asia/Kolkata").toUTC().toISO()).toBe("2026-11-15T02:30:00.000Z");
  });

  it("moves a time in the spring-forward gap forward (02:30 → 03:30 EDT)", () => {
    expect(resolveLocalTime("2026-03-08", "02:30", "America/New_York").toUTC().toISO()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("resolves an ambiguous fall-back time to the FIRST occurrence (EDT, not EST)", () => {
    expect(resolveLocalTime("2026-11-01", "01:30", "America/New_York").toUTC().toISO()).toBe("2026-11-01T05:30:00.000Z");
  });
});

describe("planOccurrences", () => {
  it("returns multiple doses per day in time order", () => {
    const occ = planOccurrences(
      rule({ times: ["20:00", "08:00"] }),
      "Asia/Kolkata",
      new Date("2026-11-15T00:00:00Z"),
      new Date("2026-11-17T00:00:00Z"),
    );
    expect(occ.map((o) => `${o.localDate} ${o.localTime}`)).toEqual([
      "2026-11-15 08:00",
      "2026-11-15 20:00",
      "2026-11-16 08:00",
      "2026-11-16 20:00",
    ]);
    expect(iso(occ[0]!.scheduledAt)).toBe("2026-11-15T02:30:00.000Z");
  });

  it("honours inclusive start and end dates", () => {
    const occ = planOccurrences(
      rule({ startDate: "2026-11-16", endDate: "2026-11-17" }),
      "UTC",
      new Date("2026-11-14T00:00:00Z"),
      new Date("2026-11-20T00:00:00Z"),
    );
    expect(occ.map((o) => o.localDate)).toEqual(["2026-11-16", "2026-11-17"]);
  });

  it("never generates doses before scheduleEffectiveFrom", () => {
    const occ = planOccurrences(
      rule({ times: ["08:00", "20:00"], scheduleEffectiveFrom: new Date("2026-11-15T12:00:00Z") }),
      "UTC",
      new Date("2026-11-15T00:00:00Z"),
      new Date("2026-11-16T00:00:00Z"),
    );
    expect(occ.map((o) => o.localTime)).toEqual(["20:00"]);
  });

  it("keeps the local calendar date when it differs from the UTC date", () => {
    const [o] = planOccurrences(rule(), "Pacific/Auckland", new Date("2026-06-09T12:00:00Z"), new Date("2026-06-10T00:00:00Z"));
    expect(o).toMatchObject({ localDate: "2026-06-10", localTime: "08:00" });
    expect(iso(o!.scheduledAt)).toBe("2026-06-09T20:00:00.000Z");
  });

  it("keeps the same local time across a spring-forward boundary", () => {
    const occ = planOccurrences(rule(), "America/New_York", new Date("2026-03-07T00:00:00Z"), new Date("2026-03-10T00:00:00Z"));
    expect(occ.map((o) => iso(o.scheduledAt))).toEqual([
      "2026-03-07T13:00:00.000Z", // EST, UTC-5
      "2026-03-08T12:00:00.000Z", // EDT, UTC-4
      "2026-03-09T12:00:00.000Z",
    ]);
  });

  it("produces exactly one dose for an ambiguous time on the fall-back day", () => {
    const occ = planOccurrences(rule({ times: ["01:30"] }), "America/New_York", new Date("2026-10-31T12:00:00Z"), new Date("2026-11-02T00:00:00Z"));
    expect(occ.filter((o) => o.localDate === "2026-11-01")).toHaveLength(1);
  });

  it("is deterministic, bounded and de-duplicates repeated times", () => {
    const args = [rule({ times: ["08:00", "08:00", "12:00"] }), "UTC", new Date("2026-11-15T00:00:00Z"), new Date("2026-11-18T00:00:00Z")] as const;
    const a = planOccurrences(...args);
    expect(a).toEqual(planOccurrences(...args));
    expect(a).toHaveLength(6); // 3 days × 2 distinct times
  });

  it("builds stable, unique dose ids", () => {
    expect(doseId("medication", "m1", "2026-11-15", "08:00")).toBe("medication:m1:2026-11-15T08:00");
    expect(doseId("routine", "m1", "2026-11-15", "08:00")).not.toBe(doseId("medication", "m1", "2026-11-15", "08:00"));
  });
});
