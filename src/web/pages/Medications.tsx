import { useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import type { Medication } from "../../shared/schemas";
import { ProfileNav } from "../components/ProfileNav";
import { Card, EmptyState, FormError, LinkButton, SecondaryButton, Shell } from "../components/ui";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { formatDate, formatTime } from "../lib/format";
import { useSession } from "../lib/session";
import { useApi } from "../lib/useApi";
import { useProfile } from "../lib/useProfile";

export default function Medications() {
  const { profileId = "" } = useParams();
  const { me } = useSession();
  const profile = useProfile(profileId);
  const meds = useApi<Medication[]>(`/profiles/${profileId}/medications`);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;

  const name = profile.data?.preferredName;
  const active = meds.data?.filter((m) => m.active) ?? [];
  const inactive = meds.data?.filter((m) => !m.active) ?? [];

  async function deactivate(id: string) {
    setError(null);
    try {
      await api(`/profiles/${profileId}/medications/${id}/deactivate`, { method: "POST", body: "{}" });
      setConfirming(null);
      meds.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Shell title="Medicines" eyebrow={profile.data?.fullName} wide nav={<ProfileNav profileId={profileId} name={name} />}>
      <FormError message={error ?? meds.error} />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted">Entered by the care team from the prescriber’s instructions. Relay never changes doses.</p>
        <LinkButton to={`/profiles/${profileId}/medications/new`}>Add medicine</LinkButton>
      </div>

      {meds.data === null && !meds.error && <p role="status">Loading medicines…</p>}
      {meds.data && active.length === 0 && <EmptyState>No active medicines yet. Add the first one from the prescription.</EmptyState>}

      <ul className="space-y-4">
        {active.map((m) => (
          <li key={m.id}>
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-bold">
                    {m.name} {m.strength && <span className="font-normal text-muted">· {m.strength}</span>}
                  </h2>
                  <p className="mt-1">
                    <span className="font-bold">Daily at </span>
                    {m.times.map(formatTime).join(", ")}
                  </p>
                  {m.instructions && <p className="mt-1 text-muted">“{m.instructions}”</p>}
                  <p className="mt-1 text-sm text-muted">
                    From {formatDate(m.startDate, { day: "numeric", month: "short", year: "numeric" })}
                    {m.endDate ? ` to ${formatDate(m.endDate, { day: "numeric", month: "short", year: "numeric" })}` : " · ongoing"} · reminder{" "}
                    {m.reminderLeadMinutes} min before
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    to={`/profiles/${profileId}/medications/${m.id}/edit`}
                    className="inline-flex min-h-11 items-center rounded-lg border-2 border-line bg-surface px-4 font-bold no-underline hover:bg-canvas"
                  >
                    Edit<span className="sr-only"> {m.name}</span>
                  </Link>
                  {confirming === m.id ? (
                    <>
                      <SecondaryButton onClick={() => deactivate(m.id)} className="border-danger text-danger">
                        Confirm stop<span className="sr-only"> {m.name}</span>
                      </SecondaryButton>
                      <SecondaryButton onClick={() => setConfirming(null)}>Keep</SecondaryButton>
                    </>
                  ) : (
                    <SecondaryButton onClick={() => setConfirming(m.id)}>
                      Stop<span className="sr-only"> {m.name}</span>
                    </SecondaryButton>
                  )}
                </div>
              </div>
              {confirming === m.id && (
                <p role="status" className="mt-3 text-sm">
                  Stopping removes upcoming reminders for {m.name}. Past records stay. Only do this if the prescriber has stopped it.
                </p>
              )}
            </Card>
          </li>
        ))}
      </ul>

      {inactive.length > 0 && (
        <section aria-labelledby="inactive-heading" className="mt-8">
          <h2 id="inactive-heading" className="mb-3 text-xl font-bold">
            Stopped medicines
          </h2>
          <ul className="space-y-2">
            {inactive.map((m) => (
              <li key={m.id} className="rounded-lg border border-line bg-surface px-4 py-3 text-muted">
                {m.name} {m.strength && `· ${m.strength}`} — was daily at {m.times.map(formatTime).join(", ")}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Shell>
  );
}
