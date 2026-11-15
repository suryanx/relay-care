import { useState, type FormEvent } from "react";
import { Link, Navigate, useParams } from "react-router";
import type { IncidentListResponse, InvitationView } from "../../shared/schemas";
import { ProfileNav } from "../components/ProfileNav";
import { Card, DangerButton, EmptyState, Field, FormError, PrimaryButton, SecondaryButton, Shell } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { errorMessage, fieldErrors } from "../lib/errors";
import { useSession } from "../lib/session";
import { useApi } from "../lib/useApi";
import { useProfile } from "../lib/useProfile";

const STATE_LABEL: Record<InvitationView["state"], string> = {
  pending: "Waiting to be accepted",
  accepted: "Accepted",
  revoked: "Cancelled",
  expired: "Expired",
};

const reauth = (err: unknown) =>
  err instanceof ApiError && err.body.code === "REAUTH_REQUIRED" ? "For your security, please sign out and sign in again, then retry within 15 minutes." : null;

export default function CareTeam() {
  const { profileId = "" } = useParams();
  const { me } = useSession();
  const profile = useProfile(profileId);
  const isAdmin = profile.data?.role === "admin";
  const invitations = useApi<InvitationView[]>(isAdmin ? `/profiles/${profileId}/invitations` : null);
  const followUps = useApi<IncidentListResponse>(isAdmin ? `/profiles/${profileId}/incidents` : null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;
  if (profile.data && !isAdmin) {
    return (
      <Shell title="Care team" wide nav={<ProfileNav profileId={profileId} name={profile.data.preferredName} role={profile.data.role} />}>
        <FormError message="Only family administrators manage the care team." />
      </Shell>
    );
  }

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const email = String(new FormData(form).get("email"));
    setBusy(true);
    setError(null);
    setFields({});
    setLink(null);
    setCopied(false);
    try {
      const res = await api<{ inviteUrl: string }>(`/profiles/${profileId}/invitations`, { method: "POST", body: JSON.stringify({ email }) });
      setLink(res.inviteUrl);
      form.reset();
      invitations.reload();
    } catch (err) {
      setFields(fieldErrors(err));
      setError(reauth(err) ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function post(path: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setError(null);
    try {
      await api(path, { method: "POST", body: "{}" });
    } catch (err) {
      setError(reauth(err) ?? errorMessage(err));
    } finally {
      invitations.reload();
      profile.reload();
      followUps.reload();
    }
  }

  const caregivers = profile.data?.members.filter((m) => m.role === "caregiver") ?? [];
  const incidents = followUps.data?.incidents ?? [];
  const handled = incidents.filter((i) => i.status === "resolved" && i.resolvedBy);

  return (
    <Shell title="Care team" eyebrow={profile.data?.fullName} wide nav={<ProfileNav profileId={profileId} name={profile.data?.preferredName} role={profile.data?.role} />}>
      <FormError message={error} />

      {followUps.data && (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xl font-bold">Follow-ups</h2>
            <Link to={`/profiles/${profileId}/follow-ups`} className="font-bold text-brand underline">
              Open follow-ups
            </Link>
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            {[
              ["Waiting", followUps.data.counts.open],
              ["Being handled", followUps.data.counts.claimed],
              ["Closed (2 days)", followUps.data.counts.resolvedToday],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md bg-oat p-4">
                <dt className="text-sm font-bold text-muted">{label}</dt>
                <dd className="num mt-1 text-4xl">{value}</dd>
              </div>
            ))}
          </dl>
          {incidents.filter((i) => i.status === "claimed").length > 0 && (
            <ul className="mt-3 space-y-1">
              {incidents
                .filter((i) => i.status === "claimed")
                .map((i) => (
                  <li key={i.id}>
                    <strong>{i.claimedBy?.name}</strong> is checking: {i.subject}
                  </li>
                ))}
            </ul>
          )}
          {handled.length > 0 && (
            <>
              <h3 className="mt-4 font-bold">Recently handled</h3>
              <ul className="space-y-1 text-sm">
                {handled.slice(0, 5).map((i) => (
                  <li key={i.id}>
                    {i.subject} — <strong>{i.resolvedBy}</strong>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}

      <Card>
        <h2 className="mb-3 text-xl font-bold">Caregivers</h2>
        {caregivers.length === 0 ? (
          <EmptyState>No caregivers yet. Invite one below.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {caregivers.map((c) => (
              <li key={c.userId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3">
                <span className="font-bold">{c.name}</span>
                <DangerButton
                  onClick={() => post(`/profiles/${profileId}/members/${c.userId}/remove`, `Remove ${c.name} from ${profile.data?.preferredName}'s care team? Their access ends immediately.`)}
                >
                  Remove access<span className="sr-only"> for {c.name}</span>
                </DangerButton>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-1 text-xl font-bold">Invite a caregiver</h2>
        <p className="mb-4 text-sm text-muted">
          They create their own account with this email address and their own passcode. The link works once and expires in 3 days.
        </p>
        <form onSubmit={invite}>
          <Field label="Caregiver’s email" name="email" type="email" required autoComplete="off" error={fields.email} />
          <PrimaryButton type="submit" busy={busy}>
            Create invitation link
          </PrimaryButton>
        </form>
        {link && (
          <div className="mt-4 rounded-md border-l-4 border-brand bg-brand-soft p-4" role="status">
            <p className="font-bold">Invitation created. Share this link privately with the caregiver — it is shown only once.</p>
            <label htmlFor="invite-link" className="sr-only">
              Invitation link
            </label>
            <input id="invite-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="mt-2 w-full rounded border border-line bg-surface px-2 py-2 text-sm" />
            <SecondaryButton
              className="mt-2"
              onClick={async () => {
                await navigator.clipboard?.writeText(link).catch(() => {});
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </SecondaryButton>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-xl font-bold">Invitations</h2>
        {invitations.data?.length === 0 && <p className="text-muted">No invitations yet.</p>}
        <ul className="space-y-2">
          {invitations.data?.map((inv) => (
            <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3">
              <span>
                <strong>{inv.emailMasked}</strong> — {STATE_LABEL[inv.state]}
                {inv.acceptedBy ? ` by ${inv.acceptedBy}` : ""}
              </span>
              {inv.state === "pending" && (
                <SecondaryButton onClick={() => post(`/profiles/${profileId}/invitations/${inv.id}/revoke`)}>
                  Cancel invitation<span className="sr-only"> for {inv.emailMasked}</span>
                </SecondaryButton>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </Shell>
  );
}
