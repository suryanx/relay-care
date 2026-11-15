import { describe, expect, it, vi } from "vitest";
import { MAX_SNOOZES, counts, demoReducer, elderFocus, initialDemoState, needsAttention, type DemoState } from "../src/web/demo/model.js";

const run = (...actions: Parameters<typeof demoReducer>[1][]) => actions.reduce<DemoState>((s, a) => demoReducer(s, a), initialDemoState());

describe("demo simulation (client-only)", () => {
  it("starts with one unconfirmed dose (not missed), one open follow-up and one owned by Meera", () => {
    const s = initialDemoState();
    expect(counts(s)).toEqual({ taken: 1, notTaken: 0, unconfirmed: 1, toCome: 2 });
    expect(needsAttention(s).map((f) => f.id)).toEqual(["f1"]);
    expect(elderFocus(s)?.id).toBe("d3");
  });

  it("elder 'I have taken it' updates the shared state seen by family and caregiver", () => {
    const s = run({ type: "elder/taken", doseId: "d3" });
    expect(s.doses.find((d) => d.id === "d3")).toMatchObject({ status: "taken", recordedBy: "Swastik" });
    expect(counts(s).taken).toBe(2);
    expect(elderFocus(s)?.id).toBe("d4");
    expect(s.activity.at(-1)?.text).toContain("Amlodipine");
  });

  it("'Remind me later' never changes the prescribed time and stops after two", () => {
    const s = run({ type: "elder/later", doseId: "d3" }, { type: "elder/later", doseId: "d3" }, { type: "elder/later", doseId: "d3" });
    const d = s.doses.find((x) => x.id === "d3")!;
    expect(d).toMatchObject({ time: "09:30", status: "due", snoozes: MAX_SNOOZES });
  });

  it("'I did not take it' is explicit and opens a follow-up", () => {
    const s = run({ type: "elder/notTaken", doseId: "d3" });
    expect(s.doses.find((d) => d.id === "d3")!.status).toBe("not_taken");
    expect(needsAttention(s).some((f) => f.kind === "not_taken" && f.doseId === "d3")).toBe(true);
  });

  it("'I need help' creates exactly one new follow-up", () => {
    const s = run({ type: "elder/help" }, { type: "elder/help" });
    expect(s.followUps.filter((f) => f.kind === "help" && f.status === "open")).toHaveLength(1);
  });

  it("a late confirmation closes the unconfirmed follow-up automatically", () => {
    const s = run({ type: "elder/taken", doseId: "d2" });
    expect(s.followUps.find((f) => f.id === "f1")).toMatchObject({ status: "resolved" });
    expect(counts(s).unconfirmed).toBe(0);
  });

  it("caregiver claims, then resolves with provenance", () => {
    const s = run({ type: "caregiver/claim", followUpId: "f1" }, { type: "caregiver/resolve", followUpId: "f1", outcome: "taken", how: "told" });
    expect(s.followUps.find((f) => f.id === "f1")).toMatchObject({ status: "resolved", owner: "Ravi" });
    expect(s.doses.find((d) => d.id === "d2")).toMatchObject({ status: "taken", recordedBy: "told to Ravi" });
  });

  it("'could not verify' never marks the dose taken", () => {
    const s = run({ type: "caregiver/claim", followUpId: "f1" }, { type: "caregiver/resolve", followUpId: "f1", outcome: "unable" });
    expect(s.doses.find((d) => d.id === "d2")!.status).toBe("unconfirmed");
  });

  it("Ravi cannot claim or resolve something Meera is already checking", () => {
    const s = run({ type: "caregiver/claim", followUpId: "f2" }, { type: "caregiver/resolve", followUpId: "f2", outcome: "helped" });
    expect(s.followUps.find((f) => f.id === "f2")).toMatchObject({ status: "claimed", owner: "Meera" });
    expect(s.notice).toContain("Meera");
  });

  it("cannot resolve without claiming first", () => {
    const s = run({ type: "caregiver/resolve", followUpId: "f1", outcome: "taken", how: "seen" });
    expect(s.followUps.find((f) => f.id === "f1")!.status).toBe("open");
  });

  it("reset restores the original story", () => {
    const s = run({ type: "elder/taken", doseId: "d3" }, { type: "caregiver/claim", followUpId: "f1" }, { type: "reset" });
    expect(s).toEqual(initialDemoState());
  });

  it("never touches the network", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    run({ type: "elder/help" }, { type: "caregiver/claim", followUpId: "f1" }, { type: "caregiver/resolve", followUpId: "f1", outcome: "not_taken", how: "seen" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

import { parseDemoRole } from "../src/web/demo/model.js";

describe("demo entry URL", () => {
  it("accepts only the three allowlisted roles", () => {
    expect(parseDemoRole("elder")).toBe("elder");
    expect(parseDemoRole("caregiver")).toBe("caregiver");
    expect(parseDemoRole("family")).toBe("family");
    for (const bad of ["admin", "ELDER", "", null, undefined, "elder<script>", "../api"]) expect(parseDemoRole(bad)).toBeNull();
  });
});
