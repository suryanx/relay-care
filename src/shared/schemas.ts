import { z } from "zod";

/** Validation shared by the API and the React forms. */

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const consentBasisValues = ["elder_consented", "legal_authority", "other"] as const;

export const consentBasisLabels: Record<(typeof consentBasisValues)[number], string> = {
  elder_consented: "They agreed to use Relay and to share their care information with this care team",
  legal_authority: "I hold legal authority to manage their care (e.g. power of attorney)",
  other: "Other arrangement (describe below)",
};

const name = z.string().trim().min(1, "Required").max(80, "Use 80 characters or fewer");

export const createProfileSchema = z.object({
  fullName: name,
  preferredName: name,
  timezone: z.string().trim().refine(isValidTimeZone, "Choose a valid time zone"),
  consentBasis: z.enum(consentBasisValues),
  consentStatement: z
    .string()
    .trim()
    .min(10, "Describe how this was agreed, in at least 10 characters")
    .max(1000),
});
export type CreateProfileInput = z.infer<typeof createProfileSchema>;

export const createElderAccountSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_.]{3,32}$/, "3–32 letters, numbers, dots or underscores"),
  passcode: z.string().min(10, "Use at least 10 characters").max(128),
});
export type CreateElderAccountInput = z.infer<typeof createElderAccountSchema>;

export type Role = "admin" | "caregiver" | "elder";

export interface ProfileSummary {
  id: string;
  fullName: string;
  preferredName: string;
  timezone: string;
  role: Role;
}

export interface ProfileDetail extends ProfileSummary {
  consent: { basis: string; statement: string; recordedBy: string; recordedAt: string };
  hasElderAccount: boolean;
  elderUsername: string | null;
  members: { userId: string; name: string; role: Role }[];
}

export interface MeResponse {
  user: { id: string; name: string; email: string | null; username: string | null };
  memberships: ProfileSummary[];
  isElder: boolean;
}
