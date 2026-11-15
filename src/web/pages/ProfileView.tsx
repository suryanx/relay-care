import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useParams } from "react-router";
import { consentBasisLabels, type AdherenceResponse, type Appointment, type Medication, type ProfileDetail } from "../../shared/schemas";
import { CountsGrid, PhaseChip, eventSummary } from "../components/adherence";
import { ProfileNav } from "../components/ProfileNav";
import { formatDate, formatTime } from "../lib/format";
import { useApi } from "../lib/useApi";
import { Card, Field, FormError, PrimaryButton, Shell } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { errorMessage, fieldErrors } from "../lib/errors";
import { useSession } from "../lib/session";

const roleLabel = { admin: "Family administrator", caregiver: "Caregiver", elder: "Elder" } as const;

export default function ProfileView() {
  const { profileId } = useParams();
  const { me } = useSession();
  const [profile, setProfile] = useState<ProfileDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [version, setVersion] = useState(0);
  const reload = useCallback(async () => setVersion((v) => v + 1), []);

  const skipFetch = !me || me.isElder;
  const meds = useApi<Medication[]>(skipFetch ? null : `/profiles/${profileId}/medications`);
  const appts = useApi<Appointment[]>(skipFetch ? null : `/profiles/${profileId}/appointments`);
  const today = useApi<AdherenceResponse>(skipFetch ? null : `/profiles/${profileId}/adherence`);
  useEffect(() => {
    if (skipFetch) return;
    let active = true;
    api<ProfileDetail>(`/profiles/${profileId}`).then(
      (data) => active && setProfile(data),
      (err: unknown) => active && setLoadError(errorMessage(err)),
    );
    return () => {
      active = false;
    };
  }, [profileId, version, skipFetch]);

  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;
  if (loadError) {
    return (
      <Shell title="Profile unavailable">
        <FormError message={loadError} />
      </Shell>
    );
  }
  if (!profile) {
    return (
      <Shell title="Loading profile…">
        <p role="status">Loading…</p>
      </Shell>
    );
  }

  return (
    <Shell title={profile.fullName} wide nav={<ProfileNav profileId={profile.id} name={profile.preferredName} role={profile.role} />}>
      {today.data && today.data.openHelpRequests.length > 0 && (
        <section aria-labelledby="help-heading" className="mb-6 rounded-xl border-2 border-amber-700 bg-amber-50 p-5 text-amber-950">
          <h2 id="help-heading" className="mb-2 text-xl font-bold">
            {profile.preferredName} asked for help ({today.data.openHelpRequests.length})
          </h2>
          <ul className="space-y-1">
            {today.data.openHelpRequests.map((h) => (
              <li key={h.id}>
                {new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", timeZone: profile.timezone }).format(
                  new Date(h.createdAt),
                )}
                {h.doseLabel ? ` — about ${h.doseLabel}` : ""}
                {h.note ? ` — “${h.note}”` : ""}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm">Please check in with {profile.preferredName}. Email alerts and follow-up tracking arrive in a later update.</p>
        </section>
      )}

      <Card>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-bold">Today’s medicines</h2>
          <Link to={`/profiles/${profile.id}/schedule`} className="font-bold text-brand underline">
            Open schedule
          </Link>
        </div>
        {today.data === null ? (
          <p role="status">Loading…</p>
        ) : (
          <>
            <CountsGrid counts={today.data.counts} />
            {today.data.doses.filter((d) => d.kind === "medication" && (d.phase === "due" || d.phase === "upcoming" || d.phase === "unconfirmed")).length > 0 && (
              <>
                <h3 className="mb-2 mt-4 font-bold">Needs attention or coming up</h3>
                <ul className="space-y-1">
                  {today.data.doses
                    .filter((d) => d.kind === "medication" && (d.phase === "due" || d.phase === "upcoming" || d.phase === "unconfirmed"))
                    .slice(0, 5)
                    .map((d) => (
                      <li key={d.id} className="flex flex-wrap items-center gap-2">
                        <span className="w-14 font-bold">{formatTime(d.localTime)}</span>
                        <span>{d.label}</span>
                        <PhaseChip phase={d.phase} />
                      </li>
                    ))}
                </ul>
              </>
            )}
            {today.data.recentActivity.length > 0 && (
              <>
                <h3 className="mb-2 mt-4 font-bold">Recent activity</h3>
                <ul className="space-y-1 text-sm">
                  {today.data.recentActivity.slice(0, 6).map((e) => (
                    <li key={e.id}>
                      <span className="font-bold">
                        {new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: profile.timezone }).format(new Date(e.recordedAt))}
                      </span>{" "}
                      {e.doseLabel} ({e.doseLocalTime}) — {eventSummary(e)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-xl font-bold">Medicines</h2>
          {meds.data === null ? (
            <p role="status">Loading…</p>
          ) : (
            <p>
              <strong>{meds.data.filter((m) => m.active).length}</strong> active medicine
              {meds.data.filter((m) => m.active).length === 1 ? "" : "s"}.{" "}
              <Link to={`/profiles/${profile.id}/schedule`} className="font-bold text-brand underline">
                See today’s schedule
              </Link>
            </p>
          )}
        </Card>
        <Card>
          <h2 className="mb-3 text-xl font-bold">Next appointment</h2>
          {appts.data === null ? (
            <p role="status">Loading…</p>
          ) : appts.data[0] ? (
            <p>
              <strong>{appts.data[0].doctorName}</strong>
              {appts.data[0].specialty ? ` (${appts.data[0].specialty})` : ""} — {formatDate(appts.data[0].localDate)} at{" "}
              {formatTime(appts.data[0].localTime)}
            </p>
          ) : (
            <p className="text-muted">None scheduled.</p>
          )}
        </Card>
        <Card>
          <h2 className="mb-3 text-xl font-bold">Care recipient</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="font-bold">Name</dt>
            <dd>{profile.fullName}</dd>
            <dt className="font-bold">Called</dt>
            <dd>{profile.preferredName}</dd>
            <dt className="font-bold">Time zone</dt>
            <dd>{profile.timezone}</dd>
            <dt className="font-bold">Own sign-in</dt>
            <dd>{profile.hasElderAccount ? `Yes (${profile.elderUsername}) — elder view only` : "Not set up"}</dd>
          </dl>
          <p className="mt-3 rounded-lg bg-canvas p-2 text-sm">
            Viewing as: <strong>{roleLabel[profile.role]}</strong>
          </p>
        </Card>
        <Card>
          <h2 className="mb-3 text-xl font-bold">Care team</h2>
          <ul className="space-y-1">
            {profile.members
              .filter((m) => m.role !== "elder")
              .map((m) => (
                <li key={m.userId}>
                  {m.name} <span className="text-muted">— {roleLabel[m.role]}</span>
                </li>
              ))}
          </ul>
        </Card>
      </div>

      <Card>
        <h2 className="mb-3 text-xl font-bold">Care agreement (as recorded)</h2>
        <p className="mb-2">{consentBasisLabels[profile.consent.basis as keyof typeof consentBasisLabels] ?? profile.consent.basis}</p>
        <blockquote className="mb-2 border-l-4 border-line pl-4 italic">{profile.consent.statement}</blockquote>
        <p className="text-sm text-muted">
          Recorded by {profile.consent.recordedBy} on {new Date(profile.consent.recordedAt).toLocaleString()}. This is an
          attestation, not verified proof of authority.
        </p>
      </Card>

      {profile.role === "admin" && <ElderAccountPanel profile={profile} onChange={reload} />}
    </Shell>
  );
}

function ElderAccountPanel({ profile, onChange }: { profile: ProfileDetail; onChange: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  function explain(err: unknown) {
    if (err instanceof ApiError && err.body.code === "REAUTH_REQUIRED") {
      return "For your security, please sign out and sign in again, then retry within 15 minutes.";
    }
    return errorMessage(err);
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await api(`/profiles/${profile.id}/elder-account`, {
        method: "POST",
        body: JSON.stringify({ username: form.get("username"), passcode: form.get("passcode") }),
      });
      await onChange();
    } catch (err) {
      setFields(fieldErrors(err));
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ revoked: number }>(`/profiles/${profile.id}/elder-account/revoke-sessions`, { method: "POST" });
      setNotice(`Signed out ${res.revoked} elder device session${res.revoked === 1 ? "" : "s"}.`);
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-3 text-xl font-bold">{profile.preferredName}’s own sign-in</h2>
      <FormError message={error} />
      {notice && (
        <p role="status" className="mb-4 font-bold text-brand">
          {notice}
        </p>
      )}
      {profile.hasElderAccount ? (
        <>
          <p className="mb-4">
            Username: <strong>{profile.elderUsername}</strong>. Sign in once on their device; it stays signed in for 30 days
            of use.
          </p>
          <button type="button" onClick={revoke} disabled={busy} className="min-h-12 rounded-lg border-2 border-danger px-4 py-2 font-bold text-danger">
            Sign out all of {profile.preferredName}’s devices
          </button>
        </>
      ) : (
        <form onSubmit={create}>
          <p className="mb-4 text-muted">
            Create a simple sign-in for {profile.preferredName}’s phone or tablet. They get a calm daily view only — no
            administrator access.
          </p>
          <Field label="Username" name="username" autoComplete="off" required error={fields.username} hint="3–32 lowercase letters, numbers, dots or underscores." />
          <Field label="Passcode" name="passcode" type="password" autoComplete="new-password" required minLength={10} error={fields.passcode} hint="At least 10 characters." />
          <PrimaryButton type="submit" busy={busy}>
            Create elder sign-in
          </PrimaryButton>
        </form>
      )}
    </Card>
  );
}
