import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Card, Field, FormError, PrimaryButton, Shell } from "../components/ui";
import { authClient } from "../lib/auth-client";
import { useSession } from "../lib/session";

type Mode = "email" | "username";

export default function SignIn() {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [mode, setMode] = useState<Mode>("email");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password"));
    setBusy(true);
    setError(null);
    const { error: authError } =
      mode === "email"
        ? await authClient.signIn.email({ email: String(form.get("email")).trim(), password })
        : await authClient.signIn.username({ username: String(form.get("username")).trim().toLowerCase(), password });
    setBusy(false);
    if (authError) {
      setError(
        authError.status === 429
          ? "Too many sign-in attempts. Please wait a minute and try again."
          : "Those details did not match. Please check and try again.",
      );
      return;
    }
    const me = await refresh();
    navigate(me?.isElder ? "/elder" : "/");
  }

  return (
    <Shell title="Sign in to Relay">
      <Card>
        <fieldset className="mb-6">
          <legend className="mb-2 font-bold">Who is signing in?</legend>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
            <label className="flex min-h-12 items-center gap-2">
              <input type="radio" name="mode" checked={mode === "email"} onChange={() => setMode("email")} className="size-5" />
              Family member or caregiver
            </label>
            <label className="flex min-h-12 items-center gap-2">
              <input type="radio" name="mode" checked={mode === "username"} onChange={() => setMode("username")} className="size-5" />
              Setting up an elder's device
            </label>
          </div>
        </fieldset>
        <form onSubmit={onSubmit}>
          <FormError message={error} />
          {mode === "email" ? (
            <Field key="email" label="Email" name="email" type="email" autoComplete="email" required />
          ) : (
            <Field key="username" label="Elder username" name="username" autoComplete="username" required hint="Created by the family administrator." />
          )}
          <Field label="Passcode" name="password" type="password" autoComplete="current-password" required />
          <PrimaryButton type="submit" busy={busy}>
            Sign in
          </PrimaryButton>
        </form>
      </Card>
      <p>
        New here? <Link to="/register" className="font-bold text-brand underline">Create a family administrator account</Link>
      </p>
    </Shell>
  );
}
