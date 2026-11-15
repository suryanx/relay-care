import { and, desc, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import { createInvitationSchema, invitationTokenSchema, type InvitationView } from "../../shared/schemas.js";
import type { Auth } from "../auth.js";
import { HttpError, asyncHandler, forbidDemo, requireFreshSession, requireMember, requireSession } from "../authz.js";
import type { Database } from "../db/client.js";
import { caregiverInvitations, user } from "../db/schema.js";
import { acceptInvitation, createInvitation, invitationState, previewInvitation, removeCaregiver } from "../services/invitations.js";
import { maskEmail } from "../services/notifications.js";

export function careTeamRoutes(db: Database, auth: Auth, appUrl: string): Router {
  const router = Router();
  const signedIn = requireSession(auth, db);
  const admin = [signedIn, requireMember(db, ["admin"])];

  router.post(
    "/profiles/:profileId/invitations",
    ...admin,
    forbidDemo,
    requireFreshSession,
    asyncHandler(async (req, res) => {
      const { email } = createInvitationSchema.parse(req.body);
      const { invitation, token } = await createInvitation(db, { profileId: req.membership!.profileId, email, invitedBy: req.authCtx!.userId });
      // The token travels in the URL fragment, which browsers never send to servers or in Referer headers.
      // It is returned exactly once; only its hash is stored.
      res.status(201).json({ id: invitation.id, expiresAt: invitation.expiresAt.toISOString(), inviteUrl: `${appUrl}/invite#${token}` });
    }),
  );

  router.get(
    "/profiles/:profileId/invitations",
    ...admin,
    asyncHandler(async (req, res) => {
      const rows = await db
        .select({ inv: caregiverInvitations, inviter: user.name })
        .from(caregiverInvitations)
        .innerJoin(user, eq(user.id, caregiverInvitations.invitedBy))
        .where(eq(caregiverInvitations.profileId, req.membership!.profileId))
        .orderBy(desc(caregiverInvitations.createdAt))
        .limit(50);
      const accepterIds = [...new Set(rows.map((r) => r.inv.acceptedBy).filter((id): id is string => Boolean(id)))];
      const accepters = new Map(
        accepterIds.length ? (await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, accepterIds))).map((u) => [u.id, u.name]) : [],
      );
      const now = new Date();
      res.json(
        rows.map(
          ({ inv, inviter }): InvitationView => ({
            id: inv.id,
            emailMasked: maskEmail(inv.email),
            state: invitationState(inv, now),
            invitedBy: inviter,
            createdAt: inv.createdAt.toISOString(),
            expiresAt: inv.expiresAt.toISOString(),
            acceptedBy: inv.acceptedBy ? (accepters.get(inv.acceptedBy) ?? null) : null,
          }),
        ),
      );
    }),
  );

  router.post(
    "/profiles/:profileId/invitations/:invitationId/revoke",
    ...admin,
    asyncHandler(async (req, res) => {
      const [row] = await db
        .update(caregiverInvitations)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(
          and(
            eq(caregiverInvitations.id, String(req.params.invitationId)),
            eq(caregiverInvitations.profileId, req.membership!.profileId),
            eq(caregiverInvitations.status, "pending"),
          ),
        )
        .returning({ id: caregiverInvitations.id });
      if (!row) throw new HttpError(409, "NOT_PENDING", "Only pending invitations can be revoked.");
      res.json({ revoked: true });
    }),
  );

  router.post(
    "/profiles/:profileId/members/:userId/remove",
    ...admin,
    requireFreshSession,
    asyncHandler(async (req, res) => {
      await removeCaregiver(db, req.membership!.profileId, String(req.params.userId), req.authCtx!.userId);
      res.json({ removed: true });
    }),
  );

  // Public: lets the invited person see who invited them before signing in. No medical data.
  router.post(
    "/invitations/preview",
    asyncHandler(async (req, res) => {
      const { token } = invitationTokenSchema.parse(req.body);
      res.json(await previewInvitation(db, token));
    }),
  );

  router.post(
    "/invitations/accept",
    signedIn,
    forbidDemo,
    asyncHandler(async (req, res) => {
      const { token } = invitationTokenSchema.parse(req.body);
      const result = await acceptInvitation(db, token, { userId: req.authCtx!.userId, email: req.authCtx!.user.email });
      res.json(result);
    }),
  );

  return router;
}
