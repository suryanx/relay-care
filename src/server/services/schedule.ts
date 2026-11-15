import { and, eq, gt, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Database } from "../db/client.js";
import { doses, medications, profiles, routines, type DoseKind } from "../db/schema.js";

/** Doses are materialised only inside [now - LOOKBACK, now + HORIZON). Never unbounded. */
export const GENERATION_LOOKBACK_HOURS = 24;
export const GENERATION_HORIZON_HOURS = 48;

export interface ScheduleRule {
  times: string[]; // "HH:mm", local to the profile
  startDate: string; // YYYY-MM-DD, inclusive
  endDate: string | null; // inclusive
  scheduleEffectiveFrom: Date;
}

export interface Occurrence {
  localDate: string;
  localTime: string;
  scheduledAt: Date;
}

/**
 * Converts a local wall-clock time to an instant in `zone`.
 * - Non-existent times (spring-forward gap) move forward by the gap, e.g. 02:30 → 03:30.
 * - Ambiguous times (fall-back overlap) resolve to the FIRST occurrence (earlier instant),
 *   so a dose is never scheduled an hour late.
 */
export function resolveLocalTime(localDate: string, localTime: string, zone: string): DateTime {
  const naive = DateTime.fromISO(`${localDate}T${localTime}`, { zone });
  if (!naive.isValid) throw new Error(`Invalid local time ${localDate}T${localTime} in ${zone}`);
  const candidates = naive.getPossibleOffsets();
  if (candidates.length > 1) {
    return candidates.reduce((earliest, c) => (c.toMillis() < earliest.toMillis() ? c : earliest));
  }
  return naive;
}

export const doseId = (kind: DoseKind, sourceId: string, localDate: string, localTime: string) =>
  `${kind}:${sourceId}:${localDate}T${localTime}`;

/** Pure: lists every occurrence of `rule` whose instant falls in [from, to). Deterministic for given inputs. */
export function planOccurrences(rule: ScheduleRule, zone: string, from: Date, to: Date): Occurrence[] {
  const out: Occurrence[] = [];
  const lowerBound = Math.max(from.getTime(), rule.scheduleEffectiveFrom.getTime());
  // Walk local calendar days, padded by one day on each side to cover offset differences.
  let day = DateTime.fromJSDate(from, { zone }).startOf("day").minus({ days: 1 });
  const lastDay = DateTime.fromJSDate(to, { zone }).startOf("day").plus({ days: 1 });

  while (day <= lastDay) {
    const localDate = day.toISODate()!;
    const inRange = localDate >= rule.startDate && (rule.endDate === null || localDate <= rule.endDate);
    if (inRange) {
      for (const localTime of [...new Set(rule.times)].sort()) {
        const instant = resolveLocalTime(localDate, localTime, zone).toMillis();
        if (instant >= lowerBound && instant < to.getTime()) {
          out.push({ localDate, localTime, scheduledAt: new Date(instant) });
        }
      }
    }
    day = day.plus({ days: 1 });
  }
  return out.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

export function generationWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - GENERATION_LOOKBACK_HOURS * 3_600_000),
    to: new Date(now.getTime() + GENERATION_HORIZON_HOURS * 3_600_000),
  };
}

type Executor = Pick<Database, "select" | "insert" | "delete">;

/**
 * Idempotently materialises doses for all active medications and routines of a profile.
 * Safe to run repeatedly or concurrently: ids are deterministic and inserts ignore conflicts.
 * Returns the number of newly inserted doses.
 */
export async function generateDosesForProfile(db: Executor, profileId: string, now: Date = new Date()): Promise<number> {
  const [profile] = await db.select({ timezone: profiles.timezone }).from(profiles).where(eq(profiles.id, profileId));
  if (!profile) return 0;
  const { from, to } = generationWindow(now);

  const meds = await db
    .select()
    .from(medications)
    .where(and(eq(medications.profileId, profileId), eq(medications.active, true)));
  const rts = await db
    .select()
    .from(routines)
    .where(and(eq(routines.profileId, profileId), eq(routines.active, true)));

  const rows: (typeof doses.$inferInsert)[] = [];
  for (const m of meds) {
    for (const o of planOccurrences(m, profile.timezone, from, to)) {
      rows.push({
        id: doseId("medication", m.id, o.localDate, o.localTime),
        profileId,
        kind: "medication",
        medicationId: m.id,
        label: m.strength ? `${m.name} (${m.strength})` : m.name,
        detail: m.instructions,
        ...o,
      });
    }
  }
  for (const r of rts) {
    for (const o of planOccurrences(r, profile.timezone, from, to)) {
      rows.push({
        id: doseId("routine", r.id, o.localDate, o.localTime),
        profileId,
        kind: "routine",
        routineId: r.id,
        label: r.title,
        detail: r.notes,
        ...o,
      });
    }
  }
  if (rows.length === 0) return 0;
  const inserted = await db.insert(doses).values(rows).onConflictDoNothing({ target: doses.id }).returning({ id: doses.id });
  return inserted.length;
}

/**
 * After a medication/routine changes: remove its FUTURE doses that have no recorded outcome,
 * then regenerate. Past doses and any dose with an outcome are never touched.
 */
export async function replanSource(db: Executor, kind: DoseKind, sourceId: string, profileId: string, now: Date = new Date()) {
  const sourceCol = kind === "medication" ? doses.medicationId : doses.routineId;
  await db
    .delete(doses)
    .where(and(eq(sourceCol, sourceId), gt(doses.scheduledAt, now), inArray(doses.status, ["scheduled"])));
  return generateDosesForProfile(db, profileId, now);
}
