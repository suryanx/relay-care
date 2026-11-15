import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* Better Auth core tables (+ username plugin fields, DB rate limiting) */
/* ------------------------------------------------------------------ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  username: text("username").unique(),
  displayUsername: text("display_username"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

/* ------------------------------------------------------------------ */
/* Relay domain tables                                                 */
/* ------------------------------------------------------------------ */

/** How the administrator says they are authorised to manage this profile. Recorded, not verified. */
export const CONSENT_BASES = [
  "elder_consented", // the elderly person agreed directly
  "legal_authority", // e.g. power of attorney / guardianship (documents not verified by Relay)
  "other",
] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export const profiles = pgTable("profiles", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`),
  fullName: text("full_name").notNull(),
  preferredName: text("preferred_name").notNull(),
  timezone: text("timezone").notNull(),
  // Consent / authorisation record (an attestation by the admin — not legal proof).
  consentBasis: text("consent_basis").$type<ConsentBasis>().notNull(),
  consentStatement: text("consent_statement").notNull(),
  consentRecordedBy: text("consent_recorded_by")
    .notNull()
    .references(() => user.id),
  consentRecordedAt: timestamp("consent_recorded_at", { withTimezone: true }).notNull().defaultNow(),
  elderUserId: text("elder_user_id")
    .unique()
    .references(() => user.id, { onDelete: "set null" }),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const MEMBER_ROLES = ["admin", "caregiver", "elder"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const profileMembers = pgTable(
  "profile_members",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<MemberRole>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.userId] }),
    index("profile_members_user_idx").on(t.userId),
    // An account can be the elderly person for at most one profile.
    uniqueIndex("profile_members_one_elder_per_user")
      .on(t.userId)
      .where(sql`${t.role} = 'elder'`),
  ],
);

export const schema = {
  user,
  session,
  account,
  verification,
  rateLimit,
  profiles,
  profileMembers,
};
