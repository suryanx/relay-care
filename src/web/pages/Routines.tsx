import { useState, type FormEvent } from "react";
import { Navigate, useParams } from "react-router";
import type { Routine } from "../../shared/schemas";
import { ProfileNav } from "../components/ProfileNav";
import { TimesField, timesError } from "../components/TimesField";
import { Card, EmptyState, Field, FormError, PrimaryButton, SecondaryButton, Shell } from "../components/ui";
import { api } from "../lib/api";
import { errorMessage, fieldErrors } from "../lib/errors";
import { formatTime, todayIn } from "../lib/format";
import { useSession } from "../lib/session";
import { useApi } from "../lib/useApi";
import { useProfile } from "../lib/useProfile";

export default function Routines() {
  const { profileId = "" } = useParams();
  const { me } = useSession();
  const profile = useProfile(profileId);
  const list = useApi<Routine[]>(`/profiles/${profileId}/routines`);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;

  const active = list.data?.filter((r) => r.active) ?? [];

  async function stop(r: Routine) {
    setError(null);
    try {
      await api(`/profiles/${profileId}/routines/${r.id}/deactivate`, { method: "POST", body: "{}" });
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Shell title="Daily routines" eyebrow={profile.data?.fullName} wide nav={<ProfileNav profileId={profileId} name={profile.data?.preferredName} />}>
      <p className="mb-6 text-muted">
        Simple everyday tasks the family has agreed on, like drinking water or a short walk. Routines are not medicines.
      </p>
      <FormError message={error ?? list.error} />

      {editing ? (
        profile.data && (
          <RoutineEditor
            key={editing === "new" ? "new" : editing.id}
            profileId={profileId}
            timezone={profile.data.timezone}
            existing={editing === "new" ? null : editing}
            onDone={() => {
              setEditing(null);
              list.reload();
            }}
          />
        )
      ) : (
        <div className="mb-6">
          <PrimaryButton type="button" onClick={() => setEditing("new")}>
            Add routine
          </PrimaryButton>
        </div>
      )}

      {list.data && active.length === 0 && !editing && <EmptyState>No routines yet.</EmptyState>}
      <ul className="space-y-3">
        {active.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
            <div>
              <p className="text-lg font-bold">{r.title}</p>
              <p className="text-muted">
                Daily at {r.times.map(formatTime).join(", ")}
                {r.notes ? ` · ${r.notes}` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <SecondaryButton onClick={() => setEditing(r)}>
                Edit<span className="sr-only"> {r.title}</span>
              </SecondaryButton>
              <SecondaryButton onClick={() => stop(r)}>
                Stop<span className="sr-only"> {r.title}</span>
              </SecondaryButton>
            </div>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function RoutineEditor({
  profileId,
  timezone,
  existing,
  onDone,
}: {
  profileId: string;
  timezone: string;
  existing: Routine | null;
  onDone: () => void;
}) {
  const [times, setTimes] = useState(existing?.times ?? ["09:00"]);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await api(existing ? `/profiles/${profileId}/routines/${existing.id}` : `/profiles/${profileId}/routines`, {
        method: existing ? "PUT" : "POST",
        body: JSON.stringify({
          title: f.get("title"),
          notes: f.get("notes"),
          times,
          startDate: existing?.startDate ?? todayIn(timezone),
          endDate: existing?.endDate ?? null,
        }),
      });
      onDone();
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-4 text-xl font-bold">{existing ? "Edit routine" : "New routine"}</h2>
      <form onSubmit={onSubmit}>
        <FormError message={error} />
        <Field label="What to do" name="title" required maxLength={100} defaultValue={existing?.title} hint="e.g. Drink a glass of water" error={fields.title} />
        <Field label="Note (optional)" name="notes" maxLength={300} defaultValue={existing?.notes ?? ""} error={fields.notes} />
        <TimesField times={times} onChange={setTimes} error={timesError(fields)} />
        <div className="flex flex-wrap gap-3">
          <PrimaryButton type="submit" busy={busy}>
            {existing ? "Save routine" : "Add routine"}
          </PrimaryButton>
          <SecondaryButton onClick={onDone}>Cancel</SecondaryButton>
        </div>
      </form>
    </Card>
  );
}
