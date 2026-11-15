import { describe, expect, it } from "vitest";
import {
  SYSTEM_ACTOR,
  decide,
  dosePhase,
  summarize,
  unconfirmedDeadline,
  type Actor,
  type DoseState,
} from "../src/server/services/adherence.js";

const T = new Date("2026-11-15T08:00:00Z"); // scheduled time
const at = (min: number) => new Date(T.getTime() + min * 60_000);
const GRACE = 60;
const elder: Actor = { userId: "elder-1", role: "elder" };
const admin: Actor = { userId: "admin-1", role: "admin" };
const caregiver: Actor = { userId: "care-1", role: "caregiver" };

const dose = (over: Partial<DoseState> = {}): DoseState => ({
  kind: "medication",
  status: "scheduled",
  scheduledAt: T,
  snoozeCount: 0,
  snoozeUntil: null,
  outcomeRecordedBy: null,
  outcomeRecordedAt: null,
  ...over,
});
const record = (outcome: "taken" | "not_taken") => ({ type: "record" as const, outcome, source: "self_reported" as const });

describe("state machine: recording outcomes", () => {
  it("Scheduled → Taken records provenance and claimed time", () => {
    const d = decide(dose(), record("taken"), elder, at(5), GRACE);
    expect(d.kind).toBe("apply");
    if (d.kind !== "apply") return;
    expect(d.patch).toMatchObject({ status: "taken", outcomeSource: "self_reported", outcomeRecordedBy: "elder-1" });
    expect(d.event).toMatchObject({ type: "outcome", to: "taken" });
  });

  it("Scheduled → Not Taken only when explicitly reported", () => {
    const d = decide(dose(), record("not_taken"), elder, at(5), GRACE);
    expect(d.kind === "apply" && d.patch.status).toBe("not_taken");
  });

  it("allows confirming up to 60 minutes early, not before", () => {
    expect(decide(dose(), record("taken"), elder, at(-60), GRACE).kind).toBe("apply");
    expect(decide(dose(), record("taken"), elder, at(-61), GRACE)).toMatchObject({ kind: "reject", code: "TOO_EARLY" });
  });

  it("Unconfirmed → Taken / Not Taken (late confirmation) keeps the claimed time separate", () => {
    const claimed = at(30);
    const d = decide(dose({ status: "unconfirmed" }), { ...record("taken"), occurredAt: claimed }, caregiver, at(240), GRACE);
    expect(d.kind).toBe("apply");
    if (d.kind === "apply") {
      expect(d.patch.outcomeOccurredAt).toEqual(claimed);
      expect(d.patch.outcomeRecordedAt).toEqual(at(240));
    }
    expect(decide(dose({ status: "unconfirmed" }), record("not_taken"), elder, at(240), GRACE).kind).toBe("apply");
  });

  it("rejects a claimed time in the future", () => {
    expect(decide(dose(), { ...record("taken"), occurredAt: at(30) }, elder, at(5), GRACE)).toMatchObject({ kind: "reject", status: 400 });
  });

  it("is idempotent for the same outcome and 409 for a conflicting one", () => {
    expect(decide(dose({ status: "taken" }), record("taken"), elder, at(5), GRACE).kind).toBe("noop");
    expect(decide(dose({ status: "taken" }), record("not_taken"), elder, at(5), GRACE)).toMatchObject({
      kind: "reject",
      status: 409,
      code: "OUTCOME_ALREADY_RECORDED",
    });
  });

  it("never records on a void dose", () => {
    expect(decide(dose({ status: "void" }), record("taken"), elder, at(5), GRACE)).toMatchObject({ kind: "reject", code: "DOSE_VOID" });
  });
});

describe("state machine: system Unconfirmed transition", () => {
  it("Scheduled → Unconfirmed only after the grace period, only by the system", () => {
    expect(decide(dose(), { type: "mark_unconfirmed" }, SYSTEM_ACTOR, at(59), GRACE).kind).toBe("noop");
    const d = decide(dose(), { type: "mark_unconfirmed" }, SYSTEM_ACTOR, at(60), GRACE);
    expect(d.kind === "apply" && d.patch.status).toBe("unconfirmed");
    expect(decide(dose(), { type: "mark_unconfirmed" }, admin, at(90), GRACE)).toMatchObject({ kind: "reject", status: 403 });
  });

  it("never turns silence into Not Taken, and never touches recorded outcomes", () => {
    for (const status of ["taken", "not_taken", "unconfirmed", "void"] as const) {
      expect(decide(dose({ status }), { type: "mark_unconfirmed" }, SYSTEM_ACTOR, at(600), GRACE).kind).toBe("noop");
    }
  });

  it("respects a snooze that extends past the grace period", () => {
    const snoozed = dose({ snoozeUntil: at(70), snoozeCount: 2 });
    expect(unconfirmedDeadline(snoozed, GRACE)).toEqual(at(70));
    expect(decide(snoozed, { type: "mark_unconfirmed" }, SYSTEM_ACTOR, at(65), GRACE).kind).toBe("noop");
    expect(decide(snoozed, { type: "mark_unconfirmed" }, SYSTEM_ACTOR, at(70), GRACE).kind).toBe("apply");
  });

  it("does not mark routines unconfirmed", () => {
    expect(decide(dose({ kind: "routine" }), { type: "mark_unconfirmed" }, SYSTEM_ACTOR, at(600), GRACE).kind).toBe("noop");
  });
});

describe("state machine: remind me later", () => {
  it("postpones 15 minutes without changing the scheduled time, at most twice", () => {
    const first = decide(dose(), { type: "snooze" }, elder, at(0), GRACE);
    expect(first.kind).toBe("apply");
    if (first.kind === "apply") {
      expect(first.patch).toEqual({ snoozeCount: 1, snoozeUntil: at(15) });
      expect(first.patch).not.toHaveProperty("scheduledAt");
    }
    expect(decide(dose({ snoozeCount: 1 }), { type: "snooze" }, elder, at(15), GRACE).kind).toBe("apply");
    expect(decide(dose({ snoozeCount: 2 }), { type: "snooze" }, elder, at(30), GRACE)).toMatchObject({ code: "SNOOZE_LIMIT" });
  });

  it("is not available too early, after the deadline, or once recorded", () => {
    expect(decide(dose(), { type: "snooze" }, elder, at(-61), GRACE)).toMatchObject({ code: "TOO_EARLY" });
    expect(decide(dose(), { type: "snooze" }, elder, at(60), GRACE)).toMatchObject({ code: "TOO_LATE" });
    expect(decide(dose({ status: "taken" }), { type: "snooze" }, elder, at(5), GRACE)).toMatchObject({ code: "NOT_SNOOZABLE" });
  });
});

describe("state machine: corrections", () => {
  const recorded = dose({ status: "taken", outcomeRecordedBy: "elder-1", outcomeRecordedAt: at(5) });
  const correct = { type: "correct" as const, outcome: "not_taken" as const, source: "reported_by_other" as const, note: "Tablet found unopened" };

  it("lets an admin or the original recorder correct within 24 hours", () => {
    expect(decide(recorded, correct, admin, at(60), GRACE).kind).toBe("apply");
    expect(decide(recorded, { ...correct, source: "self_reported" }, elder, at(60), GRACE).kind).toBe("apply");
  });

  it("refuses others, out-of-window corrections, and doses without an outcome", () => {
    expect(decide(recorded, correct, caregiver, at(60), GRACE)).toMatchObject({ kind: "reject", status: 403 });
    expect(decide(recorded, correct, admin, at(5 + 24 * 60 + 1), GRACE)).toMatchObject({ code: "CORRECTION_WINDOW_CLOSED" });
    expect(decide(dose({ status: "unconfirmed" }), correct, admin, at(60), GRACE)).toMatchObject({ code: "NOTHING_TO_CORRECT" });
  });

  it("produces a correction event, not an overwrite", () => {
    const d = decide(recorded, correct, admin, at(60), GRACE);
    expect(d.kind === "apply" && d.event.type).toBe("correction");
  });
});

describe("phases and summaries", () => {
  it("separates upcoming from due without changing stored state", () => {
    expect(dosePhase(dose(), at(-90))).toBe("upcoming");
    expect(dosePhase(dose(), at(-30))).toBe("due");
    expect(dosePhase(dose({ status: "unconfirmed" }), at(90))).toBe("unconfirmed");
  });

  it("keeps Not Taken and Unconfirmed separate and never counts Scheduled or Void as missed", () => {
    const counts = summarize([
      { kind: "medication", status: "taken" },
      { kind: "medication", status: "taken" },
      { kind: "medication", status: "not_taken" },
      { kind: "medication", status: "unconfirmed" },
      { kind: "medication", status: "scheduled" },
      { kind: "medication", status: "void" },
      { kind: "routine", status: "taken" },
    ]);
    expect(counts).toEqual({ total: 5, taken: 2, notTaken: 1, unconfirmed: 1, pending: 1 });
  });
});
