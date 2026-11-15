import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import type { Medication } from "../../shared/schemas";
import { ProfileNav } from "../components/ProfileNav";
import { TimesField, timesError } from "../components/TimesField";
import { Card, Field, FormError, PrimaryButton, Shell, TextArea } from "../components/ui";
import { api } from "../lib/api";
import { errorMessage, fieldErrors } from "../lib/errors";
import { todayIn } from "../lib/format";
import { useSession } from "../lib/session";
import { useApi } from "../lib/useApi";
import { useProfile } from "../lib/useProfile";

export default function MedicationForm() {
  const { profileId = "", medicationId } = useParams();
  const { me } = useSession();
  const profile = useProfile(profileId);
  const existing = useApi<Medication>(medicationId ? `/profiles/${profileId}/medications/${medicationId}` : null);

  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;

  const title = medicationId ? "Edit medicine" : "Add a medicine";
  const ready = profile.data && (!medicationId || existing.data);
  return (
    <Shell title={title} eyebrow={profile.data?.fullName} wide nav={<ProfileNav profileId={profileId} name={profile.data?.preferredName} role={profile.data?.role} />}>
      <FormError message={profile.error ?? existing.error} />
      {ready ? (
        <MedicationEditor key={existing.data?.id ?? "new"} profileId={profileId} timezone={profile.data!.timezone} existing={existing.data} />
      ) : (
        !profile.error && !existing.error && <p role="status">Loading…</p>
      )}
    </Shell>
  );
}

function MedicationEditor({ profileId, timezone, existing }: { profileId: string; timezone: string; existing: Medication | null }) {
  const navigate = useNavigate();
  const [times, setTimes] = useState<string[]>(existing?.times ?? ["08:00"]);
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
      await api(existing ? `/profiles/${profileId}/medications/${existing.id}` : `/profiles/${profileId}/medications`, {
        method: existing ? "PUT" : "POST",
        body: JSON.stringify({
          name: f.get("name"),
          strength: f.get("strength"),
          instructions: f.get("instructions"),
          times,
          startDate: f.get("startDate"),
          endDate: f.get("endDate") || null,
          reminderLeadMinutes: Number(f.get("reminderLeadMinutes")),
        }),
      });
      navigate(`/profiles/${profileId}/medications`);
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
        <p className="mb-5 rounded-lg bg-canvas p-3 text-sm">
          Copy these details exactly from the prescription or the prescriber. Relay does not suggest or change doses.
        </p>
        <Field label="Medicine name" name="name" required maxLength={100} defaultValue={existing?.name} error={fields.name} />
        <Field label="Strength (optional)" name="strength" maxLength={50} defaultValue={existing?.strength ?? ""} hint="As printed, e.g. 10 mg" error={fields.strength} />
        <TextArea
          label="Prescribed instructions (optional)"
          name="instructions"
          maxLength={500}
          defaultValue={existing?.instructions ?? ""}
          hint="As written by the prescriber, e.g. “one tablet after breakfast”."
          error={fields.instructions}
        />
        <TimesField times={times} onChange={setTimes} error={timesError(fields)} />
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Start date" name="startDate" type="date" required defaultValue={existing?.startDate ?? todayIn(timezone)} error={fields.startDate} />
          <Field label="End date (optional)" name="endDate" type="date" defaultValue={existing?.endDate ?? ""} hint="Leave empty if ongoing." error={fields.endDate} />
        </div>
        <Field
          label="Reminder lead time (minutes before)"
          name="reminderLeadMinutes"
          type="number"
          min={0}
          max={120}
          required
          defaultValue={existing?.reminderLeadMinutes ?? 15}
          error={fields.reminderLeadMinutes}
        />
        {existing && <p className="mb-4 text-sm text-muted">Saving updates upcoming doses only. Past records are kept as they were.</p>}
        <PrimaryButton type="submit" busy={busy}>
          {existing ? "Save changes" : "Add medicine"}
        </PrimaryButton>
      </form>
    </Card>
  );
}
