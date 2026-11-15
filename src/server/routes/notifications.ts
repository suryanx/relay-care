import { createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Router, type RequestHandler } from "express";
import type { NotificationCenterResponse, NotificationPreferences } from "../../shared/schemas.js";
import { notificationPreferencesSchema } from "../../shared/schemas.js";
import type { Auth } from "../auth.js";
import { HttpError, asyncHandler, requireMember, requireSession } from "../authz.js";
import type { Database } from "../db/client.js";
import { doses, notifications, profileMembers, sweepRuns, user } from "../db/schema.js";
import { MANUAL_SWEEP_COOLDOWN_SECONDS, maskEmail, realSendsUsed, runSweep, type NotifierConfig } from "../services/notifications.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time bearer-secret check for the external scheduler. Disabled (503) when no secret is configured. */
export function requireSweepSecret(secret: string | undefined): RequestHandler {
  return (req, _res, next) => {
    if (!secret) return next(new HttpError(503, "SWEEP_DISABLED", "Scheduled sweeps are not configured."));
    const header = req.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!presented || !timingSafeEqual(digest(presented), digest(secret))) {
      return next(new HttpError(401, "UNAUTHORIZED", "Invalid scheduler credentials."));
    }
    next();
  };
}

/** Counts only — never recipients, addresses or medical content. */
const publicSummary = (s: Awaited<ReturnType<typeof runSweep>>) => s;

export function sweepRoute(db: Database, cfg: NotifierConfig, secret: string | undefined): Router {
  const router = Router();
  router.post(
    "/internal/sweep",
    requireSweepSecret(secret),
    asyncHandler(async (_req, res) => {
      const summary = await runSweep(db, cfg, { trigger: "scheduler" });
      res.status(summary.status === "skipped_locked" ? 202 : 200).json(publicSummary(summary));
    }),
  );
  return router;
}

export function notificationRoutes(db: Database, auth: Auth, cfg: NotifierConfig): Router {
  const router = Router();
  const signedIn = requireSession(auth, db);
  const adminOnly = [signedIn, requireMember(db, ["admin"])];
  const team = [signedIn, requireMember(db, ["admin", "caregiver"])];

  router.get(
    "/profiles/:profileId/notifications",
    ...adminOnly,
    asyncHandler(async (req, res) => {
      const { profileId } = req.membership!;
      const rows = await db
        .select({ n: notifications, email: user.email, recipientName: user.name, doseLabel: doses.label, doseTime: doses.localTime })
        .from(notifications)
        .leftJoin(user, eq(user.id, notifications.recipientUserId))
        .leftJoin(doses, eq(doses.id, notifications.doseId))
        .where(eq(notifications.profileId, profileId))
        .orderBy(desc(notifications.createdAt))
        .limit(100);
      const [lastRun] = await db
        .select()
        .from(sweepRuns)
        .where(eq(sweepRuns.profileId, profileId))
        .orderBy(desc(sweepRuns.startedAt))
        .limit(1);

      const body: NotificationCenterResponse = {
        mode: cfg.realSendEnabled && cfg.provider.name !== "console" ? "real" : "preview",
        realSendsUsed: await realSendsUsed(db),
        realSendCap: cfg.realSendCap,
        cooldownSeconds: MANUAL_SWEEP_COOLDOWN_SECONDS,
        lastRun: lastRun ? { startedAt: lastRun.startedAt.toISOString(), trigger: lastRun.trigger, summary: lastRun.summary ? JSON.parse(lastRun.summary) : null } : null,
        items: rows.map(({ n, email, recipientName, doseLabel, doseTime }) => ({
          id: n.id,
          type: n.type,
          status: n.status,
          subject: n.subject,
          preview: n.preview,
          related: doseLabel ? `${doseLabel} · ${doseTime}` : n.appointmentId ? "Appointment" : n.helpRequestId ? "Help request" : null,
          recipientName: recipientName ?? "Former member",
          recipientMasked: maskEmail(email),
          dueAt: n.dueAt.toISOString(),
          createdAt: n.createdAt.toISOString(),
          sentAt: n.sentAt?.toISOString() ?? null,
          attempts: n.attempts,
          nextAttemptAt: n.status === "queued" ? n.nextAttemptAt.toISOString() : null,
          providerAccepted: n.status === "accepted",
          hasProviderMessageId: Boolean(n.providerMessageId),
          lastError: n.lastError,
          cancelReason: n.cancelReason,
        })),
      };
      res.json(body);
    }),
  );

  router.post(
    "/profiles/:profileId/notifications/run-check",
    ...adminOnly,
    asyncHandler(async (req, res) => {
      const { profileId } = req.membership!;
      const [last] = await db
        .select({ startedAt: sweepRuns.startedAt })
        .from(sweepRuns)
        .where(and(eq(sweepRuns.profileId, profileId), eq(sweepRuns.trigger, "manual")))
        .orderBy(desc(sweepRuns.startedAt))
        .limit(1);
      const wait = last ? MANUAL_SWEEP_COOLDOWN_SECONDS - Math.floor((Date.now() - last.startedAt.getTime()) / 1000) : 0;
      if (wait > 0) {
        res.setHeader("Retry-After", String(wait));
        throw new HttpError(429, "COOLDOWN", `Please wait ${wait} seconds before running another check.`);
      }
      // Same business logic as /internal/sweep, scoped to this profile. No client-supplied time or recipient.
      const summary = await runSweep(db, cfg, { trigger: "manual", profileId, triggeredBy: req.authCtx!.userId });
      if (summary.status === "skipped_locked") throw new HttpError(409, "BUSY", "A reminder check is already running. Try again shortly.");
      res.json(summary);
    }),
  );

  router.get(
    "/profiles/:profileId/notification-preferences",
    ...team,
    asyncHandler(async (req, res) => {
      const [m] = await db
        .select({ notifyDoseReminders: profileMembers.notifyDoseReminders, notifyAlerts: profileMembers.notifyAlerts, notifyAppointments: profileMembers.notifyAppointments })
        .from(profileMembers)
        .where(and(eq(profileMembers.profileId, req.membership!.profileId), eq(profileMembers.userId, req.authCtx!.userId)));
      res.json(m satisfies NotificationPreferences | undefined);
    }),
  );

  router.put(
    "/profiles/:profileId/notification-preferences",
    ...team,
    asyncHandler(async (req, res) => {
      const input = notificationPreferencesSchema.parse(req.body);
      const [m] = await db
        .update(profileMembers)
        .set(input)
        .where(
          and(
            eq(profileMembers.profileId, req.membership!.profileId),
            eq(profileMembers.userId, req.authCtx!.userId),
            inArray(profileMembers.role, ["admin", "caregiver"]),
          ),
        )
        .returning({ notifyDoseReminders: profileMembers.notifyDoseReminders, notifyAlerts: profileMembers.notifyAlerts, notifyAppointments: profileMembers.notifyAppointments });
      res.json(m);
    }),
  );

  return router;
}

