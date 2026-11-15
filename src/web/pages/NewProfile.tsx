import { useMemo, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { consentBasisLabels, consentBasisValues, type ProfileSummary } from "../../shared/schemas";
import { Card, Field, FormError, PrimaryButton, Shell, TextArea, inputClass } from "../components/ui";
import { api } from "../lib/api";
import { errorMessage, fieldErrors } from "../lib/errors";
import { useSession } from "../lib/session";

export default function NewProfile() {
  const { me, refresh } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [basis, setBasis] = useState<(typeof consentBasisValues)[number] | null>(null);
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
          consentStatement: form.get("consentStatement") || null,
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
            <p id="timezone-hint" className="mb-2 text-base text-muted">
              Reminders and greetings follow their local time.
            </p>
            <select
              id="timezone"
              name="timezone"
              defaultValue={defaultTz}
              aria-describedby="timezone-hint"
              className={inputClass}
            >
              {timezones.map((tz) => (
                <option key={tz}>{tz}</option>
              ))}
            </select>
          </div>

          <fieldset className="mb-5" aria-describedby="consent-hint">
            <legend className="mb-1 font-bold">How was this care arrangement agreed?</legend>
            <p id="consent-hint" className="mb-3 text-base text-muted">
              Relay records what you tell us and when. It does not verify it, and being family does not by itself give authority over a capable adult’s
              decisions.
            </p>
            <div className="grid gap-2">
              {consentBasisValues.map((v) => (
                <label
                  key={v}
                  className="flex min-h-12 cursor-pointer items-start gap-3 rounded-md border-2 border-line-strong bg-surface px-4 py-3 has-[:checked]:border-brand has-[:checked]:bg-brand-soft"
                >
                  <input type="radio" name="consentBasis" value={v} required checked={basis === v} onChange={() => setBasis(v)} className="mt-1 size-5 shrink-0" />
                  <span>{consentBasisLabels[v]}</span>
                </label>
              ))}
            </div>
            {fields.consentBasis && <p className="mt-1.5 font-bold text-danger">{fields.consentBasis}</p>}
          </fieldset>

          {(basis === "other" || basis === "legal_authority") && (
            <TextArea
              label={basis === "other" ? "Describe the arrangement" : "Details (optional)"}
              name="consentStatement"
              required={basis === "other"}
              minLength={basis === "other" ? 10 : undefined}
              maxLength={1000}
              hint={
                basis === "other"
                  ? "For example: “Swastik asked his daughter Priya to help manage his medicines.”"
                  : "For example, the type of document. Relay records this as your declaration and does not verify it."
              }
              error={fields.consentStatement}
            />
          )}
          <PrimaryButton type="submit" busy={busy}>
            Create profile
          </PrimaryButton>
        </form>
      </Card>
    </Shell>
  );
}
