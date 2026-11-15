import { and, eq, isNull } from "drizzle-orm";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { Role } from "../shared/schemas.js";
import type { Auth } from "./auth.js";
import { FAMILY_SESSION_MAX_AGE_SECONDS, FRESH_SESSION_SECONDS } from "./auth.js";
import type { Database } from "./db/client.js";
import { profileMembers, profiles, session } from "./db/schema.js";

export interface AuthContext {
  userId: string;
  sessionId: string;
  sessionCreatedAt: Date;
  user: { id: string; name: string; email: string; username?: string | null };
}

export interface MembershipContext {
  profileId: string;
  role: Role;
}

declare module "express-serve-static-core" {
  interface Request {
    authCtx?: AuthContext;
    membership?: MembershipContext;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Rejects with 401 unless a valid Better Auth session cookie is present.
 *
 * Session policy:
 * - Elder device sessions use Better Auth's rolling 30-day session (revocable by an admin).
 * - Family administrator / caregiver sessions are capped at FAMILY_SESSION_MAX_AGE_SECONDS
 *   from sign-in, regardless of renewal; expired ones are deleted and must sign in again.
 * - Sensitive operations additionally require a fresh sign-in (requireFreshSession).
 */
export function requireSession(auth: Auth, db: Database): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const result = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!result) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in.");

      const sessionAgeMs = Date.now() - new Date(result.session.createdAt).getTime();
      if (sessionAgeMs > FAMILY_SESSION_MAX_AGE_SECONDS * 1000) {
        const [elder] = await db
          .select({ userId: profileMembers.userId })
          .from(profileMembers)
          .where(and(eq(profileMembers.userId, result.user.id), eq(profileMembers.role, "elder")))
          .limit(1);
        if (!elder) {
          await db.delete(session).where(eq(session.id, result.session.id));
          throw new HttpError(401, "SESSION_EXPIRED", "Your session has expired. Please sign in again.");
        }
      }

      req.authCtx = {
        userId: result.user.id,
        sessionId: result.session.id,
        sessionCreatedAt: new Date(result.session.createdAt),
        user: result.user,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Rejects with 403 unless the signed-in user holds one of `roles` on the :profileId in the URL. */
export function requireMember(db: Database, roles: readonly Role[]): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const userId = req.authCtx?.userId;
      const profileId = req.params.profileId;
      if (!userId) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in.");
      if (typeof profileId !== "string") throw new HttpError(400, "BAD_REQUEST", "Missing profile id.");

      const [row] = await db
        .select({ role: profileMembers.role, archivedAt: profiles.archivedAt })
        .from(profileMembers)
        .innerJoin(profiles, eq(profiles.id, profileMembers.profileId))
        .where(and(eq(profileMembers.profileId, profileId), eq(profileMembers.userId, userId)))
        .limit(1);

      if (!row || !roles.includes(row.role)) {
        throw new HttpError(403, "FORBIDDEN", "You do not have access to this.");
      }
      if (row.archivedAt) throw new HttpError(404, "ARCHIVED", "This care circle has been archived.");
      req.membership = { profileId, role: row.role };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Sensitive actions require a sign-in within the last FRESH_SESSION_SECONDS. */
export const requireFreshSession: RequestHandler = (req, _res, next) => {
  const created = req.authCtx?.sessionCreatedAt;
  if (!created || Date.now() - created.getTime() > FRESH_SESSION_SECONDS * 1000) {
    next(new HttpError(403, "REAUTH_REQUIRED", "For your security, please sign in again to do this."));
    return;
  }
  next();
};

/** Wraps async route handlers so rejections reach the error middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** Elder-device routes: resolves the ONE profile this elder account belongs to (never from the client). */
export function requireElder(db: Database): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const userId = req.authCtx?.userId;
      if (!userId) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in.");
      const [row] = await db
        .select({ profileId: profileMembers.profileId })
        .from(profileMembers)
        .innerJoin(profiles, eq(profiles.id, profileMembers.profileId))
        .where(and(eq(profileMembers.userId, userId), eq(profileMembers.role, "elder"), isNull(profiles.archivedAt)))
        .limit(1);
      if (!row) throw new HttpError(403, "FORBIDDEN", "This page is for elder accounts.");
      req.membership = { profileId: row.profileId, role: "elder" };
      next();
    } catch (err) {
      next(err);
    }
  };
}
