import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { Role } from "../shared/schemas.js";
import type { Auth } from "./auth.js";
import { FRESH_SESSION_SECONDS } from "./auth.js";
import type { Database } from "./db/client.js";
import { profileMembers } from "./db/schema.js";

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

/** Rejects with 401 unless a valid Better Auth session cookie is present. */
export function requireSession(auth: Auth): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const result = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!result) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in.");
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
        .select({ role: profileMembers.role })
        .from(profileMembers)
        .where(and(eq(profileMembers.profileId, profileId), eq(profileMembers.userId, userId)))
        .limit(1);

      if (!row || !roles.includes(row.role)) {
        throw new HttpError(403, "FORBIDDEN", "You do not have access to this.");
      }
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
