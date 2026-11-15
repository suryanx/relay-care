import { useMemo, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { consentBasisLabels, consentBasisValues, type ProfileSummary } from "../../shared/schemas";
import { Card, Field, FormError, PrimaryButton, Shell } from "../components/ui";
import { api } from "../lib/api";
import { errorMessage, fieldErrors } from "../lib/errors";
import { useSession } from "../lib/session";

export default function NewProfile() {
  const { me, refresh } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const timezones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  const defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const profile = await api<ProfileSummary>("/profiles", {
        method: "POST",
        body: JSON.stringify({
          fullName: form.get("fullName"),
          preferredName: form.get("preferredName"),
          timezone: form.get("timezone"),
          consentBasis: form.get("consentBasis"),
          consentStatement: form.get("consentStatement"),
        }),
      });
      await refresh();
      navigate(`/profiles/${profile.id}`);
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="Create a care profile">
      <p className="mb-6 text-muted">Set up Relay for the person you care for. Use synthetic details for demos.</p>
      <Card>
        <form onSubmit={onSubmit}>
          <FormError message={error} />
          <Field label="Their full name" name="fullName" required maxLength={80} error={fields.fullName} />
          <Field
            label="What they like to be called"
            name="preferredName"
            required
            maxLength={80}
            hint="Used in their greeting, e.g. “Good morning, Swastik”."
            error={fields.preferredName}
          />
          <div className="mb-5">
            <label htmlFor="timezone" className="mb-1 block font-bold">
              Their time zone
            </label>
            <p id="timezone-hint" className="mb-2 text-sm text-muted">
              Reminders and greetings follow their local time.
            </p>
            <select
              id="timezone"
              name="timezone"
              defaultValue={defaultTz}
              aria-describedby="timezone-hint"
              className="w-full rounded-lg border-2 border-line bg-surface px-3 py-3"
            >
              {timezones.map((tz) => (
                <option key={tz}>{tz}</option>
              ))}
            </select>
          </div>

          <fieldset className="mb-5">
            <legend className="mb-1 font-bold">How is this care arrangement agreed?</legend>
            <p className="mb-3 text-sm text-muted">
              Relay records what you tell us. It does not verify legal authority, and family relationship alone does not
              give authority over a capable adult’s decisions.
            </p>
            {consentBasisValues.map((v, i) => (
              <label key={v} className="mb-2 flex min-h-12 items-start gap-3">
                <input type="radio" name="consentBasis" value={v} required defaultChecked={i === 0} className="mt-1 size-5 shrink-0" />
                <span>{consentBasisLabels[v]}</span>
              </label>
            ))}
          </fieldset>

          <div className="mb-6">
            <label htmlFor="consentStatement" className="mb-1 block font-bold">
              Describe the agreement
            </label>
            <p id="consentStatement-hint" className="mb-2 text-sm text-muted">
              For example: “Swastik agreed on 14 Nov that Priya and Ravi may see his medicine schedule.”
            </p>
            <textarea
              id="consentStatement"
              name="consentStatement"
              required
              minLength={10}
              maxLength={1000}
              rows={3}
              aria-describedby={`consentStatement-hint${fields.consentStatement ? " consentStatement-err" : ""}`}
              aria-invalid={fields.consentStatement ? true : undefined}
              className="w-full rounded-lg border-2 border-line bg-surface px-3 py-3"
            />
            {fields.consentStatement && (
              <p id="consentStatement-err" className="mt-1 text-sm font-bold text-danger">
                {fields.consentStatement}
              </p>
            )}
          </div>
          <PrimaryButton type="submit" busy={busy}>
            Create profile
          </PrimaryButton>
        </form>
      </Card>
    </Shell>
  );
}
