import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import type { Appointment } from "../../shared/schemas";
import { ProfileNav } from "../components/ProfileNav";
import { Card, Field, FormError, PrimaryButton, Shell, TextArea } from "../components/ui";
import { api } from "../lib/api";
import { errorMessage, fieldErrors } from "../lib/errors";
import { todayIn } from "../lib/format";
import { useSession } from "../lib/session";
import { useApi } from "../lib/useApi";
import { useProfile } from "../lib/useProfile";

export default function AppointmentForm() {
  const { profileId = "", appointmentId } = useParams();
  const { me } = useSession();
  const profile = useProfile(profileId);
  const existing = useApi<Appointment>(appointmentId ? `/profiles/${profileId}/appointments/${appointmentId}` : null);

  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;

  const ready = profile.data && (!appointmentId || existing.data);
  return (
    <Shell
      title={appointmentId ? "Edit appointment" : "Add an appointment"}
      eyebrow={profile.data?.fullName}
      wide
      nav={<ProfileNav profileId={profileId} name={profile.data?.preferredName} role={profile.data?.role} />}
    >
      <FormError message={profile.error ?? existing.error} />
      {ready ? (
        <AppointmentEditor key={existing.data?.id ?? "new"} profileId={profileId} timezone={profile.data!.timezone} existing={existing.data} />
      ) : (
        !profile.error && !existing.error && <p role="status">Loading…</p>
      )}
    </Shell>
  );
}

function AppointmentEditor({ profileId, timezone, existing }: { profileId: string; timezone: string; existing: Appointment | null }) {
  const navigate = useNavigate();
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
      await api(existing ? `/profiles/${profileId}/appointments/${existing.id}` : `/profiles/${profileId}/appointments`, {
        method: existing ? "PUT" : "POST",
        body: JSON.stringify({
          doctorName: f.get("doctorName"),
          specialty: f.get("specialty"),
          date: f.get("date"),
          time: f.get("time"),
          location: f.get("location"),
          notes: f.get("notes"),
          reminderHoursBefore: Number(f.get("reminderHoursBefore")),
        }),
      });
      navigate(`/profiles/${profileId}/appointments`);
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <FormError message={error} />
        <Field label="Doctor" name="doctorName" required maxLength={100} defaultValue={existing?.doctorName} error={fields.doctorName} />
        <Field label="Specialty (optional)" name="specialty" maxLength={80} defaultValue={existing?.specialty ?? ""} error={fields.specialty} />
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Date" name="date" type="date" required min={todayIn(timezone)} defaultValue={existing?.localDate} error={fields.date} />
          <Field label="Time" name="time" type="time" required defaultValue={existing?.localTime} hint={`Local time (${timezone})`} error={fields.time} />
        </div>
        <Field label="Location (optional)" name="location" maxLength={200} defaultValue={existing?.location ?? ""} error={fields.location} />
        <TextArea label="Notes (optional)" name="notes" maxLength={1000} defaultValue={existing?.notes ?? ""} hint="e.g. Bring the medicine list." error={fields.notes} />
        <Field
          label="Email reminder (hours before)"
          name="reminderHoursBefore"
          type="number"
          min={1}
          max={72}
          required
          defaultValue={existing?.reminderHoursBefore ?? 24}
          error={fields.reminderHoursBefore}
        />
        <PrimaryButton type="submit" busy={busy}>
          {existing ? "Save changes" : "Add appointment"}
        </PrimaryButton>
      </form>
    </Card>
  );
}
