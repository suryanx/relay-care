import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { consentBasisLabels, type AdherenceResponse, type Appointment, type Medication, type ProfileDetail } from "../../shared/schemas";
import { CountsGrid, PhaseChip, eventSummary } from "../components/adherence";
import { ProfileNav } from "../components/ProfileNav";
import { formatDate, formatTime } from "../lib/format";
import { useApi } from "../lib/useApi";
import { Card, DangerButton, Field, FormError, Loading, PrimaryButton, Shell, buttonClass } from "../components/ui";
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
      <Shell title="Loading…">
        <Loading />
      </Shell>
    );
  }

  const fmtLocal = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: profile.timezone }).format(new Date(iso));
  const upcoming = today.data?.doses.filter((d) => d.kind === "medication" && (d.phase === "due" || d.phase === "upcoming" || d.phase === "unconfirmed")) ?? [];
  const activeMeds = meds.data?.filter((m) => m.active).length ?? 0;
  const nextAppt = appts.data?.[0];

  return (
    <Shell title={`${profile.preferredName}’s day`} eyebrow={profile.fullName} wide nav={<ProfileNav profileId={profile.id} name={profile.preferredName} role={profile.role} />}>
      {/* 1. What needs attention */}
      {today.data && today.data.openHelpRequests.length > 0 && (
        <section aria-labelledby="help-heading" className="mb-6 rounded-lg border-l-4 border-terracotta bg-attention-soft p-5">
          <h2 id="help-heading" className="font-display text-2xl text-ink">
            {profile.preferredName} asked for help
          </h2>
          <ul className="mt-2 space-y-1 text-lg">
            {today.data.openHelpRequests.map((h) => (
              <li key={h.id}>
                <span className="num font-bold">{fmtLocal(h.createdAt, { hour: "2-digit", minute: "2-digit" })}</span>
                {h.doseLabel ? ` about ${h.doseLabel}` : ""}
                {h.note ? `: “${h.note}”` : ""}
              </li>
            ))}
          </ul>
          <Link to={`/profiles/${profile.id}/follow-ups`} className={`${buttonClass("primary", "sm")} mt-4`}>
            Go to follow-ups
          </Link>
        </section>
      )}

      {/* 2. Today's medicines */}
      <Card>
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-2xl">Today’s medicines</h2>
          <Link to={`/profiles/${profile.id}/schedule`} className="font-bold text-brand underline-offset-4 hover:underline">
            Full schedule
          </Link>
        </div>
        {today.data === null ? (
          <Loading />
        ) : (
          <>
            <CountsGrid counts={today.data.counts} />
            {upcoming.length > 0 && (
              <>
                <h3 className="mb-2 mt-6 font-bold">Coming up or needing an answer</h3>
                <ul className="divide-y divide-line">
                  {upcoming.slice(0, 5).map((d) => (
                    <li key={d.id} className="grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] items-center gap-x-4 gap-y-1 py-3 sm:grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)_auto]">
                      <span className="num text-xl">{formatTime(d.localTime)}</span>
                      <span className="min-w-0 text-lg">{d.label}</span>
                      <span className="col-start-2 sm:col-start-auto">
                        <PhaseChip phase={d.phase} />
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card tone="oat" className="mb-0">
          <h2 className="font-display text-2xl">Next appointment</h2>
          {appts.data === null ? (
            <Loading />
          ) : nextAppt ? (
            <>
              <p className="num mt-3 text-xl text-brand">
                {formatDate(nextAppt.localDate, { weekday: "short", day: "numeric", month: "short" })}, {formatTime(nextAppt.localTime)}
              </p>
              <p className="mt-1 text-lg font-bold">
                {nextAppt.doctorName}
                {nextAppt.specialty ? `, ${nextAppt.specialty}` : ""}
              </p>
              {nextAppt.location && <p className="text-muted">{nextAppt.location}</p>}
            </>
          ) : (
            <p className="mt-3 text-muted">Nothing booked.</p>
          )}
          <Link to={`/profiles/${profile.id}/appointments`} className="mt-4 inline-block font-bold text-brand underline-offset-4 hover:underline">
            All appointments
          </Link>
        </Card>
        <Card tone="oat" className="mb-0">
          <h2 className="font-display text-2xl">Care plan</h2>
          <p className="mt-3 text-lg">
            <span className="num text-2xl text-brand">{activeMeds}</span> active medicine{activeMeds === 1 ? "" : "s"}
          </p>
          <p className="text-lg">
            <span className="num text-2xl text-brand">{profile.members.filter((m) => m.role !== "elder").length}</span> people in the care team
          </p>
          <Link to={`/profiles/${profile.id}/medications`} className="mt-4 inline-block font-bold text-brand underline-offset-4 hover:underline">
            Manage medicines
          </Link>
        </Card>
      </div>

      {/* 3. Recent activity */}
      {today.data && today.data.recentActivity.length > 0 && (
        <section aria-labelledby="activity-heading" className="mt-10">
          <h2 id="activity-heading" className="mb-4 font-display text-2xl">
            Recent activity
          </h2>
          <ol className="space-y-3 border-l-2 border-line pl-5">
            {today.data.recentActivity.slice(0, 6).map((e) => (
              <li key={e.id} className="text-lg">
                <span className="num font-bold">{fmtLocal(e.recordedAt, { hour: "2-digit", minute: "2-digit" })}</span>{" "}
                <span className="text-muted">
                  {e.doseLabel} (<span className="num">{e.doseLocalTime}</span>)
                </span>
                <br />
                {eventSummary(e)}
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* 4. Secondary: profile, consent and the elder's own sign-in */}
      <details className="group mt-12 rounded-lg border border-line bg-surface">
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-5 font-display text-2xl">
          Profile and access
          <span aria-hidden="true" className="text-xl text-muted transition-transform group-open:rotate-180">
            ⌄
          </span>
        </summary>
        <div className="space-y-8 px-5 pb-6">
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="mb-2 font-bold">Care recipient</h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted">Name</dt>
                <dd>{profile.fullName}</dd>
                <dt className="text-muted">Called</dt>
                <dd>{profile.preferredName}</dd>
                <dt className="text-muted">Time zone</dt>
                <dd>{profile.timezone}</dd>
                <dt className="text-muted">Own sign-in</dt>
                <dd>{profile.hasElderAccount ? `Yes (${profile.elderUsername}), elder view only` : "Not set up"}</dd>
              </dl>
              <p className="mt-3 inline-block rounded-md bg-oat px-3 py-1.5">
                Viewing as: <strong>{roleLabel[profile.role]}</strong>
              </p>
            </div>
            <div>
              <h3 className="mb-2 font-bold">Care team</h3>
              <ul className="space-y-1">
                {profile.members
                  .filter((m) => m.role !== "elder")
                  .map((m) => (
                    <li key={m.userId}>
                      {m.name} <span className="text-muted">({roleLabel[m.role].toLowerCase()})</span>
                    </li>
                  ))}
              </ul>
            </div>
          </div>
          <div>
            <h3 className="mb-2 font-bold">Care agreement, as recorded</h3>
            <p>{consentBasisLabels[profile.consent.basis as keyof typeof consentBasisLabels] ?? profile.consent.basis}</p>
            <blockquote className="my-2 border-l-4 border-line pl-4 italic">{profile.consent.statement}</blockquote>
            <p className="text-base text-muted">
              Recorded by {profile.consent.recordedBy} on {new Date(profile.consent.recordedAt).toLocaleString()}. This is an attestation, not verified proof of
              authority.
            </p>
          </div>
          {profile.role === "admin" && <ElderAccountPanel profile={profile} onChange={reload} />}
          {profile.role === "admin" && <ArchivePanel profile={profile} />}
        </div>
      </details>
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
    <div>
      <h3 className="mb-2 font-bold">{profile.preferredName}’s own sign-in</h3>
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
          <DangerButton onClick={revoke} disabled={busy}>
            Sign out all of {profile.preferredName}’s devices
          </DangerButton>
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
    </div>
  );
}

/** Archive, not delete: hides the care circle and stops reminders; every record is kept and can be restored. */
function ArchivePanel({ profile }: { profile: ProfileDetail }) {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function archive(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const confirmName = String(new FormData(e.currentTarget).get("confirmName") ?? "");
    setBusy(true);
    setError(null);
    try {
      await api(`/profiles/${profile.id}/archive`, { method: "POST", body: JSON.stringify({ confirmName }) });
      await refresh();
      navigate("/home");
    } catch (err) {
      setError(
        err instanceof ApiError && err.body.code === "REAUTH_REQUIRED"
          ? "For your security, please sign out and sign in again, then retry within 15 minutes."
          : errorMessage(err),
      );
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border-2 border-danger/40 p-5">
      <h3 className="font-bold text-danger">Archive this care circle</h3>
      <p className="mt-1">
        Use this if the care circle was created by mistake or is no longer needed. Archiving does <strong>not</strong> delete anything:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>{profile.preferredName}’s care circle disappears for you and every caregiver, and their device is signed out.</li>
        <li>Reminder emails stop.</li>
        <li>Medicines, appointments and the full history are kept. You can restore it from “People you care for”.</li>
      </ul>
      <p className="mt-2 text-base text-muted">To remove one caregiver instead, use Care team. This never deletes anyone’s account.</p>
      <FormError message={error} />
      <form onSubmit={archive} className="mt-4">
        <Field label={`Type “${profile.preferredName}” to confirm`} name="confirmName" required autoComplete="off" />
        <DangerButton type="submit" busy={busy}>
          Archive {profile.preferredName}’s care circle
        </DangerButton>
      </form>
    </div>
  );
}
