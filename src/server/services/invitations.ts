import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { HttpError } from "../authz.js";
import type { Database } from "../db/client.js";
import { caregiverInvitations, incidentEvents, incidents, profileMembers, profiles, user } from "../db/schema.js";
import { maskEmail } from "./notifications.js";

export const INVITE_TTL_HOURS = 72;

/** Only this hash is stored; the raw token exists once, in the link shown to the administrator. */
export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export type InvitationRow = typeof caregiverInvitations.$inferSelect;
export type InvitationState = "pending" | "accepted" | "revoked" | "expired";

export function invitationState(inv: Pick<InvitationRow, "status" | "expiresAt">, now: Date): InvitationState {
  return inv.status === "pending" && inv.expiresAt <= now ? "expired" : inv.status;
}

export async function createInvitation(
  db: Database,
  input: { profileId: string; email: string; invitedBy: string; now?: Date },
): Promise<{ invitation: InvitationRow; token: string }> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();

  const [existingMember] = await db
    .select({ userId: profileMembers.userId })
    .from(profileMembers)
    .innerJoin(user, eq(user.id, profileMembers.userId))
    .where(and(eq(profileMembers.profileId, input.profileId), eq(user.email, email)));
  if (existingMember) throw new HttpError(409, "ALREADY_MEMBER", "This person is already part of the care team.");

  const token = randomBytes(32).toString("base64url");
  const invitation = await db.transaction(async (tx) => {
    // A new invitation replaces any still-pending one for the same person and profile.
    await tx
      .update(caregiverInvitations)
      .set({ status: "revoked", revokedAt: now })
      .where(and(eq(caregiverInvitations.profileId, input.profileId), eq(caregiverInvitations.email, email), eq(caregiverInvitations.status, "pending")));
    const [row] = await tx
      .insert(caregiverInvitations)
      .values({
        profileId: input.profileId,
        email,
        tokenHash: hashToken(token),
        invitedBy: input.invitedBy,
        expiresAt: new Date(now.getTime() + INVITE_TTL_HOURS * 3_600_000),
        createdAt: now,
      })
      .returning();
    return row!;
  });
  return { invitation, token };
}

async function findByToken(db: Database, token: string) {
  if (!token || token.length < 20 || token.length > 200) return undefined;
  const [inv] = await db.select().from(caregiverInvitations).where(eq(caregiverInvitations.tokenHash, hashToken(token)));
  return inv;
}

/** What someone holding the link may see before signing in: no medical data. */
export async function previewInvitation(db: Database, token: string, now: Date = new Date()) {
  const inv = await findByToken(db, token);
  if (!inv) return { state: "invalid" as const };
  const [p] = await db.select({ preferredName: profiles.preferredName }).from(profiles).where(eq(profiles.id, inv.profileId));
  const [inviter] = await db.select({ name: user.name }).from(user).where(eq(user.id, inv.invitedBy));
  return {
    state: invitationState(inv, now),
    careRecipient: p?.preferredName ?? "",
    invitedBy: inviter?.name ?? "",
    invitedEmail: inv.email,
    invitedEmailMasked: maskEmail(inv.email),
  };
}

/**
 * Accepts an invitation for the signed-in user. Single-use under concurrency: the pending → accepted
 * transition is a conditional update, and membership is created in the same transaction.
 */
export async function acceptInvitation(
  db: Database,
  token: string,
  account: { userId: string; email: string },
  now: Date = new Date(),
): Promise<{ profileId: string; alreadyMember: boolean }> {
  const inv = await findByToken(db, token);
  if (!inv) throw new HttpError(404, "INVITATION_INVALID", "This invitation link is not valid.");

  const state = invitationState(inv, now);
  if (state === "accepted") {
    if (inv.acceptedBy === account.userId) return { profileId: inv.profileId, alreadyMember: true }; // idempotent
    throw new HttpError(409, "INVITATION_USED", "This invitation has already been used.");
  }
  if (state === "revoked") throw new HttpError(410, "INVITATION_REVOKED", "This invitation was cancelled by the family administrator.");
  if (state === "expired") throw new HttpError(410, "INVITATION_EXPIRED", "This invitation has expired. Ask for a new one.");

  if (account.email.trim().toLowerCase() !== inv.email) {
    throw new HttpError(403, "EMAIL_MISMATCH", `This invitation is for ${maskEmail(inv.email)}. Please sign in with that email address.`);
  }
  const [elder] = await db
    .select({ id: profileMembers.userId })
    .from(profileMembers)
    .where(and(eq(profileMembers.userId, account.userId), eq(profileMembers.role, "elder")));
  if (elder) throw new HttpError(403, "FORBIDDEN", "Elder accounts cannot join a care team.");

  const [member] = await db
    .select({ role: profileMembers.role })
    .from(profileMembers)
    .where(and(eq(profileMembers.profileId, inv.profileId), eq(profileMembers.userId, account.userId)));
  if (member) throw new HttpError(409, "ALREADY_MEMBER", "You are already part of this care team.");

  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(caregiverInvitations)
      .set({ status: "accepted", acceptedBy: account.userId, acceptedAt: now })
      .where(and(eq(caregiverInvitations.id, inv.id), eq(caregiverInvitations.status, "pending"), gt(caregiverInvitations.expiresAt, now)))
      .returning({ id: caregiverInvitations.id });
    if (!claimed) throw new HttpError(409, "INVITATION_USED", "This invitation has already been used.");
    await tx.insert(profileMembers).values({ profileId: inv.profileId, userId: account.userId, role: "caregiver" });
  });
  return { profileId: inv.profileId, alreadyMember: false };
}

/**
 * Removes a caregiver. Takes effect immediately (every request re-checks membership). Any incident
 * they had claimed goes back to the open queue, with an audit event.
 */
export async function removeCaregiver(db: Database, profileId: string, userId: string, removedBy: string, now: Date = new Date()) {
  const [m] = await db
    .select({ role: profileMembers.role })
    .from(profileMembers)
    .where(and(eq(profileMembers.profileId, profileId), eq(profileMembers.userId, userId)));
  if (!m) throw new HttpError(404, "NOT_FOUND", "Member not found.");
  if (m.role !== "caregiver") throw new HttpError(403, "FORBIDDEN", "Only caregivers can be removed here.");

  await db.transaction(async (tx) => {
    await tx.delete(profileMembers).where(and(eq(profileMembers.profileId, profileId), eq(profileMembers.userId, userId)));
    const released = await tx
      .update(incidents)
      .set({ status: "open", claimedBy: null, claimedAt: null, version: sql`${incidents.version} + 1`, updatedAt: now })
      .where(and(eq(incidents.profileId, profileId), eq(incidents.claimedBy, userId), eq(incidents.status, "claimed")))
      .returning({ id: incidents.id });
    for (const r of released) {
      await tx.insert(incidentEvents).values({ incidentId: r.id, profileId, type: "released", actorUserId: removedBy, note: "Caregiver access removed", recordedAt: now });
    }
  });
}
