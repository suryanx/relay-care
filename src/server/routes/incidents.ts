import { and, asc, desc, eq, gte, inArray, or } from "drizzle-orm";
import { Router, type Request } from "express";
import { releaseIncidentSchema, resolveIncidentSchema, type FollowUpSummary, type IncidentListResponse, type IncidentView } from "../../shared/schemas.js";
import type { Auth } from "../auth.js";
import { asyncHandler, requireMember, requireSession } from "../authz.js";
import type { Database } from "../db/client.js";
import { doses, helpRequests, incidentEvents, incidents, profileMembers, profiles, user } from "../db/schema.js";
import { ALLOWED_RESOLUTIONS, PRIORITY, claimIncident, releaseIncident, resolveIncident, syncIncidents, type IncidentActor } from "../services/incidents.js";
import { evaluateProfile } from "./adherence.js";

const SUBJECT: Record<IncidentView["sourceType"], string> = {
  dose_unconfirmed: "Medicine not confirmed",
  dose_not_taken: "Medicine reported not taken",
  help_request: "Asked for help",
};

export function incidentRoutes(db: Database, auth: Auth): Router {
  const router = Router();
  const signedIn = requireSession(auth, db);
  const team = [signedIn, requireMember(db, ["admin", "caregiver"])];
  const actorOf = (req: Request): IncidentActor => ({ userId: req.authCtx!.userId, role: req.membership!.role });

  /** Follow-up counts across every profile the signed-in care-team member belongs to (never others). */
  router.get(
    "/follow-ups/summary",
    signedIn,
    asyncHandler(async (req, res) => {
      const userId = req.authCtx!.userId;
      const mine = await db
        .select({ profileId: profiles.id, preferredName: profiles.preferredName, role: profileMembers.role })
        .from(profileMembers)
        .innerJoin(profiles, eq(profiles.id, profileMembers.profileId))
        .where(and(eq(profileMembers.userId, userId), inArray(profileMembers.role, ["admin", "caregiver"])));
      const out: FollowUpSummary[] = [];
      for (const p of mine) {
        await syncIncidents(db, new Date(), p.profileId);
        const rows = await db
          .select({ status: incidents.status, claimedBy: incidents.claimedBy })
          .from(incidents)
          .where(and(eq(incidents.profileId, p.profileId), inArray(incidents.status, ["open", "claimed"])));
        out.push({
          ...p,
          open: rows.filter((r) => r.status === "open").length,
          claimed: rows.filter((r) => r.status === "claimed").length,
          mine: rows.filter((r) => r.claimedBy === userId).length,
        });
      }
      res.json(out);
    }),
  );

  router.get(
    "/profiles/:profileId/incidents",
    ...team,
    asyncHandler(async (req, res) => {
      const { profileId, role } = req.membership!;
      const userId = req.authCtx!.userId;
      const now = new Date();
      await evaluateProfile(db, profileId, now); // brings doses, unconfirmed states and incidents up to date

      const since = new Date(now.getTime() - 48 * 3_600_000);
      const rows = await db
        .select({ i: incidents, doseLabel: doses.label, doseTime: doses.localTime, helpNote: helpRequests.note })
        .from(incidents)
        .leftJoin(doses, eq(doses.id, incidents.sourceId))
        .leftJoin(helpRequests, eq(helpRequests.id, incidents.sourceId))
        .where(and(eq(incidents.profileId, profileId), or(inArray(incidents.status, ["open", "claimed"]), gte(incidents.updatedAt, since))))
        .orderBy(desc(incidents.createdAt))
        .limit(50);
      // Active first, then high priority first, then newest. (Sorted here: text columns sort alphabetically.)
      const STATUS_ORDER = { open: 0, claimed: 1, resolved: 2, cancelled: 3 } as const;
      rows.sort(
        (a, b) =>
          STATUS_ORDER[a.i.status] - STATUS_ORDER[b.i.status] ||
          Number(b.i.priority === "high") - Number(a.i.priority === "high") ||
          b.i.createdAt.getTime() - a.i.createdAt.getTime(),
      );
      const ids = rows.map((r) => r.i.id);
      const events = ids.length
        ? await db.select().from(incidentEvents).where(inArray(incidentEvents.incidentId, ids)).orderBy(asc(incidentEvents.recordedAt))
        : [];
      const userIds = [...new Set([...rows.flatMap((r) => [r.i.claimedBy, r.i.resolvedBy]), ...events.map((e) => e.actorUserId)].filter((x): x is string => Boolean(x)))];
      const names = new Map(userIds.length ? (await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds))).map((u) => [u.id, u.name]) : []);
      const nameOf = (id: string | null) => (id ? (names.get(id) ?? "Former member") : null);

      const list: IncidentView[] = rows.map(({ i, doseLabel, doseTime, helpNote }) => ({
        id: i.id,
        sourceType: i.sourceType,
        priority: i.priority,
        reason: PRIORITY[i.sourceType].reason,
        status: i.status,
        subject: i.sourceType === "help_request" ? `${SUBJECT.help_request}${helpNote ? `: “${helpNote}”` : ""}` : `${SUBJECT[i.sourceType]}: ${doseLabel ?? "a medicine"} at ${doseTime ?? "?"}`,
        claimedBy: i.claimedBy ? { id: i.claimedBy, name: nameOf(i.claimedBy)! } : null,
        claimedByMe: i.claimedBy === userId,
        claimedAt: i.claimedAt?.toISOString() ?? null,
        resolvedBy: nameOf(i.resolvedBy),
        resolvedAt: i.resolvedAt?.toISOString() ?? null,
        resolution: i.resolution,
        resolutionNote: i.resolutionNote,
        createdAt: i.createdAt.toISOString(),
        allowedResolutions: ALLOWED_RESOLUTIONS[i.sourceType],
        canResolve: i.status === "claimed" && (i.claimedBy === userId || role === "admin"),
        canRelease: i.status === "claimed" && (i.claimedBy === userId || role === "admin"),
        events: events
          .filter((e) => e.incidentId === i.id)
          .map((e) => ({ id: e.id, type: e.type, actor: nameOf(e.actorUserId) ?? "Relay (automatic)", note: e.note, recordedAt: e.recordedAt.toISOString() })),
      }));
      const body: IncidentListResponse = {
        role: role as "admin" | "caregiver",
        counts: {
          open: list.filter((i) => i.status === "open").length,
          claimed: list.filter((i) => i.status === "claimed").length,
          mine: list.filter((i) => i.claimedByMe && i.status === "claimed").length,
          resolvedToday: list.filter((i) => i.status === "resolved").length,
        },
        incidents: list,
      };
      res.json(body);
    }),
  );

  router.post(
    "/profiles/:profileId/incidents/:incidentId/claim",
    ...team,
    asyncHandler(async (req, res) => {
      const { incident, changed } = await claimIncident(db, req.membership!.profileId, String(req.params.incidentId), actorOf(req));
      res.json({ status: incident.status, changed });
    }),
  );

  router.post(
    "/profiles/:profileId/incidents/:incidentId/release",
    ...team,
    asyncHandler(async (req, res) => {
      const { note } = releaseIncidentSchema.parse(req.body ?? {});
      const row = await releaseIncident(db, req.membership!.profileId, String(req.params.incidentId), actorOf(req), note ?? null);
      res.json({ status: row.status });
    }),
  );

  router.post(
    "/profiles/:profileId/incidents/:incidentId/resolve",
    ...team,
    asyncHandler(async (req, res) => {
      const input = resolveIncidentSchema.parse(req.body);
      const row = await resolveIncident(db, req.membership!.profileId, String(req.params.incidentId), actorOf(req), input);
      res.json({ status: row.status, resolution: row.resolution });
    }),
  );

  return router;
}
