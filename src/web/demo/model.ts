/**
 * Relay's public demo: a deterministic, client-only simulation of one fictional morning.
 * Nothing here talks to the API, the database or email. It mirrors Relay's real rules in miniature:
 * silence becomes "unconfirmed" (never "missed"), one person claims a follow-up, outcomes record how
 * someone knows, and a late confirmation closes an open follow-up automatically.
 */

export const DEMO_NOW = "09:20";
export const DEMO_DATE = "Monday, 16 November";

export type DoseStatus = "taken" | "not_taken" | "unconfirmed" | "due" | "upcoming";
export type Source = "Swastik" | "seen by Ravi" | "told to Ravi";

export interface DemoDose {
  id: string;
  time: string;
  name: string;
  strength: string;
  instructions: string;
  status: DoseStatus;
  snoozes: number;
  /** Who recorded the outcome and how they know. */
  recordedBy?: Source;
}

export type FollowUpKind = "unconfirmed" | "not_taken" | "help";
export type Owner = "Ravi" | "Meera";

export interface DemoFollowUp {
  id: string;
  kind: FollowUpKind;
  doseId?: string;
  title: string;
  openedAt: string;
  status: "open" | "claimed" | "resolved";
  owner?: Owner;
  outcome?: string;
}

export interface DemoEvent {
  time: string;
  text: string;
}

export interface DemoState {
  doses: DemoDose[];
  followUps: DemoFollowUp[];
  activity: DemoEvent[];
  /** Last thing that happened, for an on-screen confirmation. */
  notice: string | null;
  /** Monotonic counter so new follow-up ids are deterministic. */
  seq: number;
}

export const initialDemoState = (): DemoState => ({
  doses: [
    { id: "d1", time: "07:00", name: "Thyroxine", strength: "50 mcg", instructions: "On an empty stomach, with water", status: "taken", snoozes: 0, recordedBy: "Swastik" },
    { id: "d2", time: "08:00", name: "Metformin", strength: "500 mg", instructions: "One tablet with breakfast", status: "unconfirmed", snoozes: 0 },
    { id: "d3", time: "09:30", name: "Amlodipine", strength: "5 mg", instructions: "One tablet", status: "due", snoozes: 0 },
    { id: "d4", time: "20:00", name: "Atorvastatin", strength: "10 mg", instructions: "One tablet at bedtime", status: "upcoming", snoozes: 0 },
  ],
  followUps: [
    { id: "f1", kind: "unconfirmed", doseId: "d2", title: "Metformin at 08:00 not confirmed", openedAt: "09:00", status: "open" },
    { id: "f2", kind: "help", title: "Asked for help: “My knee hurts on the stairs”", openedAt: "08:45", status: "claimed", owner: "Meera" },
    { id: "f0", kind: "help", title: "Asked for help yesterday evening", openedAt: "Sun 18:10", status: "resolved", owner: "Ravi", outcome: "Help given — told to Ravi" },
  ],
  activity: [
    { time: "07:04", text: "Swastik confirmed Thyroxine as taken" },
    { time: "08:45", text: "Swastik asked for help. Meera is checking" },
    { time: "09:00", text: "Metformin at 08:00 had no answer, so it was marked unconfirmed (not missed)" },
  ],
  notice: null,
  seq: 3,
});

export type DemoAction =
  | { type: "elder/taken"; doseId: string }
  | { type: "elder/notTaken"; doseId: string }
  | { type: "elder/later"; doseId: string }
  | { type: "elder/help" }
  | { type: "caregiver/claim"; followUpId: string }
  | { type: "caregiver/release"; followUpId: string }
  | { type: "caregiver/resolve"; followUpId: string; outcome: "taken" | "not_taken" | "unable" | "helped"; how?: "seen" | "told" }
  | { type: "reset" };

export const MAX_SNOOZES = 2;

const withActivity = (s: DemoState, text: string, notice: string): DemoState => ({
  ...s,
  activity: [...s.activity, { time: DEMO_NOW, text }],
  notice,
});

const updateDose = (s: DemoState, id: string, patch: Partial<DemoDose>): DemoState => ({
  ...s,
  doses: s.doses.map((d) => (d.id === id ? { ...d, ...patch } : d)),
});

const updateFollowUp = (s: DemoState, id: string, patch: Partial<DemoFollowUp>): DemoState => ({
  ...s,
  followUps: s.followUps.map((f) => (f.id === id ? { ...f, ...patch } : f)),
});

const canRecord = (d: DemoDose) => d.status === "due" || d.status === "unconfirmed";

/** A late confirmation closes the open follow-up for that dose, like the real reconciliation. */
function reconcile(s: DemoState, doseId: string, label: string): DemoState {
  const f = s.followUps.find((x) => x.doseId === doseId && x.kind === "unconfirmed" && x.status !== "resolved");
  return f ? updateFollowUp(s, f.id, { status: "resolved", outcome: `Closed automatically: ${label}` }) : s;
}

export function demoReducer(s: DemoState, a: DemoAction): DemoState {
  switch (a.type) {
    case "reset":
      return initialDemoState();

    case "elder/taken": {
      const d = s.doses.find((x) => x.id === a.doseId);
      if (!d || !canRecord(d)) return s;
      let next = updateDose(s, d.id, { status: "taken", recordedBy: "Swastik" });
      next = reconcile(next, d.id, "Swastik confirmed it later");
      return withActivity(next, `Swastik confirmed ${d.name} (${d.time}) as taken`, `Thank you. ${d.name} is recorded as taken.`);
    }

    case "elder/notTaken": {
      const d = s.doses.find((x) => x.id === a.doseId);
      if (!d || !canRecord(d)) return s;
      let next = updateDose(s, d.id, { status: "not_taken", recordedBy: "Swastik" });
      next = reconcile(next, d.id, "Swastik reported it not taken");
      const id = `f${next.seq + 1}`;
      next = {
        ...next,
        seq: next.seq + 1,
        followUps: [...next.followUps, { id, kind: "not_taken", doseId: d.id, title: `${d.name} at ${d.time} reported not taken`, openedAt: DEMO_NOW, status: "open" }],
      };
      return withActivity(
        next,
        `Swastik reported ${d.name} (${d.time}) as not taken. A follow-up opened`,
        "Thank you for telling us. Your care team can see this. If you are unsure what to do, ask your pharmacist or doctor.",
      );
    }

    case "elder/later": {
      const d = s.doses.find((x) => x.id === a.doseId);
      if (!d || d.status !== "due" || d.snoozes >= MAX_SNOOZES) return s;
      const next = updateDose(s, d.id, { snoozes: d.snoozes + 1 });
      return withActivity(
        next,
        `Swastik asked to be reminded later about ${d.name}`,
        `Okay. We will remind you again in 15 minutes. Your medicine time is still ${d.time}.`,
      );
    }

    case "elder/help": {
      if (s.followUps.some((f) => f.kind === "help" && f.openedAt === DEMO_NOW && f.status !== "resolved")) return s; // no duplicates
      const id = `f${s.seq + 1}`;
      const next: DemoState = {
        ...s,
        seq: s.seq + 1,
        followUps: [...s.followUps, { id, kind: "help", title: "Asked for help from the demo", openedAt: DEMO_NOW, status: "open" }],
      };
      return withActivity(next, "Swastik asked for help. A follow-up opened", "Your request for help is saved. Your care team will see it in Relay.");
    }

    case "caregiver/claim": {
      const f = s.followUps.find((x) => x.id === a.followUpId);
      if (!f) return s;
      if (f.status === "claimed" && f.owner !== "Ravi") return { ...s, notice: `${f.owner} is already checking on this, so Ravi can’t claim it.` };
      if (f.status !== "open") return s;
      return withActivity(updateFollowUp(s, f.id, { status: "claimed", owner: "Ravi" }), `Ravi is checking: ${f.title}`, "You are now checking on this. Everyone else can see it.");
    }

    case "caregiver/release": {
      const f = s.followUps.find((x) => x.id === a.followUpId);
      if (!f || f.status !== "claimed" || f.owner !== "Ravi") return s;
      return withActivity(updateFollowUp(s, f.id, { status: "open", owner: undefined }), `Ravi released: ${f.title}`, "Released back to the team.");
    }

    case "caregiver/resolve": {
      const f = s.followUps.find((x) => x.id === a.followUpId);
      if (!f || f.status !== "claimed" || f.owner !== "Ravi") return s;
      const how: Source = a.how === "seen" ? "seen by Ravi" : "told to Ravi";
      let next = s;
      let label: string;
      if (a.outcome === "taken" || a.outcome === "not_taken") {
        if (!f.doseId) return s;
        next = updateDose(next, f.doseId, { status: a.outcome, recordedBy: how });
        label = `${a.outcome === "taken" ? "Medicine was taken" : "Medicine was not taken"} — ${how}`;
      } else if (a.outcome === "unable") {
        label = "Could not verify (the dose stays unconfirmed)";
      } else {
        label = `Help given — ${how}`;
      }
      next = updateFollowUp(next, f.id, { status: "resolved", outcome: label });
      return withActivity(next, `Ravi closed “${f.title}”: ${label}`, "Thank you. Recorded and closed.");
    }
  }
}

/* ---------------------------- Selectors ---------------------------- */

export function counts(s: DemoState) {
  return {
    taken: s.doses.filter((d) => d.status === "taken").length,
    notTaken: s.doses.filter((d) => d.status === "not_taken").length,
    unconfirmed: s.doses.filter((d) => d.status === "unconfirmed").length,
    toCome: s.doses.filter((d) => d.status === "due" || d.status === "upcoming").length,
  };
}

/** The elder's single focus: something due now, else the next upcoming dose. */
export const elderFocus = (s: DemoState) => s.doses.find((d) => d.status === "due") ?? s.doses.find((d) => d.status === "upcoming") ?? null;

export const needsAttention = (s: DemoState) => s.followUps.filter((f) => f.status === "open");
export const beingHandled = (s: DemoState) => s.followUps.filter((f) => f.status === "claimed");
export const resolved = (s: DemoState) => s.followUps.filter((f) => f.status === "resolved");

export const APPOINTMENT = { when: "Thursday 19 November, 10:30", doctor: "Dr. Anjali Rao", specialty: "Cardiology", place: "Lakeside Clinic, Room 4" };

/* ------------------------------ Entry URL ------------------------------ */

export const DEMO_ROLES = ["elder", "caregiver", "family"] as const;
export type DemoRole = (typeof DEMO_ROLES)[number];

/** Validates the ?role= (or legacy ?as=) parameter against an explicit allowlist. Anything else → role chooser. */
export function parseDemoRole(value: string | null | undefined): DemoRole | null {
  return DEMO_ROLES.find((r) => r === value) ?? null;
}
