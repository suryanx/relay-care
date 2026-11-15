import { useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import type { Appointment } from "../../shared/schemas";
import { ProfileNav } from "../components/ProfileNav";
import { Card, EmptyState, FormError, LinkButton, SecondaryButton, Shell } from "../components/ui";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { formatDate, formatTime } from "../lib/format";
import { useSession } from "../lib/session";
import { useApi } from "../lib/useApi";
import { useProfile } from "../lib/useProfile";

export default function Appointments() {
  const { profileId = "" } = useParams();
  const { me } = useSession();
  const profile = useProfile(profileId);
  const [showAll, setShowAll] = useState(false);
  const list = useApi<Appointment[]>(`/profiles/${profileId}/appointments${showAll ? "?include=all" : ""}`);
  const [error, setError] = useState<string | null>(null);

  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;

  async function cancel(a: Appointment) {
    setError(null);
    try {
      await api(`/profiles/${profileId}/appointments/${a.id}/cancel`, { method: "POST", body: "{}" });
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Shell title="Appointments" eyebrow={profile.data?.fullName} wide nav={<ProfileNav profileId={profileId} name={profile.data?.preferredName} role={profile.data?.role} />}>
      <FormError message={error ?? list.error} />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="size-5" />
          Show past and cancelled
        </label>
        <LinkButton to={`/profiles/${profileId}/appointments/new`}>Add appointment</LinkButton>
      </div>

      {list.data === null && !list.error && <p role="status">Loading appointments…</p>}
      {list.data?.length === 0 && <EmptyState>{showAll ? "No appointments recorded." : "No upcoming appointments."}</EmptyState>}
      <ul className="space-y-4">
        {list.data?.map((a) => {
          const cancelled = a.status === "cancelled";
          return (
            <li key={a.id}>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className={cancelled ? "text-muted" : ""}>
                    <p className="font-bold text-brand">
                      {formatDate(a.localDate)} · {formatTime(a.localTime)}
                      {cancelled && <span className="ml-2 rounded bg-canvas px-2 py-0.5 text-sm text-danger">Cancelled</span>}
                    </p>
                    <h2 className="text-xl font-bold">
                      {a.doctorName}
                      {a.specialty && <span className="font-normal text-muted"> · {a.specialty}</span>}
                    </h2>
                    {a.location && <p>{a.location}</p>}
                    {a.notes && <p className="mt-1 text-muted">{a.notes}</p>}
                    <p className="mt-1 text-sm text-muted">Reminder {a.reminderHoursBefore} h before</p>
                  </div>
                  {!cancelled && (
                    <div className="flex gap-2">
                      <Link
                        to={`/profiles/${profileId}/appointments/${a.id}/edit`}
                        className="inline-flex min-h-11 items-center rounded-lg border-2 border-line bg-surface px-4 font-bold no-underline hover:bg-canvas"
                      >
                        Edit<span className="sr-only"> appointment with {a.doctorName}</span>
                      </Link>
                      <SecondaryButton onClick={() => cancel(a)}>
                        Cancel<span className="sr-only"> appointment with {a.doctorName}</span>
                      </SecondaryButton>
                    </div>
                  )}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}
