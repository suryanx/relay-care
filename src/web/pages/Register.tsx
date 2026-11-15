import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Card, Field, FormError, PrimaryButton, Shell } from "../components/ui";
import { authClient } from "../lib/auth-client";
import { useSession } from "../lib/session";

export default function Register() {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password"));
    if (password !== String(form.get("confirm"))) {
      setError("The two passcodes do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: authError } = await authClient.signUp.email({
      name: String(form.get("name")).trim(),
      email: String(form.get("email")).trim(),
      password,
    });
    setBusy(false);
    if (authError) {
      setError(authError.status === 429 ? "Too many attempts. Please wait a minute and try again." : (authError.message ?? "Could not create the account."));
      return;
    }
    await refresh();
    navigate("/profiles/new");
  }

  return (
    <Shell title="Create a family administrator account">
      <p className="mb-6 text-muted">
        Family administrators set up Relay for an elderly relative and invite caregivers. Use synthetic data for demos.
      </p>
      <Card>
        <form onSubmit={onSubmit} noValidate={false}>
          <FormError message={error} />
          <Field label="Your name" name="name" autoComplete="name" required maxLength={80} />
          <Field label="Email" name="email" type="email" autoComplete="email" required />
          <Field
            label="Passcode"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            hint="At least 10 characters. A short phrase is easier to remember."
          />
          <Field label="Confirm passcode" name="confirm" type="password" autoComplete="new-password" required minLength={10} />
          <PrimaryButton type="submit" busy={busy}>
            Create account
          </PrimaryButton>
        </form>
      </Card>
      <p>
        Already have an account? <Link to="/sign-in" className="font-bold text-brand underline">Sign in</Link>
      </p>
    </Shell>
  );
}
