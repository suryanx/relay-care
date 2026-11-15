import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Card, Field, FormError, PrimaryButton, Shell } from "../components/ui";
import { authClient } from "../lib/auth-client";
import { useSession } from "../lib/session";

type Mode = "email" | "username";

const DEMO_SHORTCUTS = [
  { role: "elder", person: "Swastik", label: "Elder: one medicine at a time, four large buttons" },
  { role: "caregiver", person: "Ravi", label: "Caregiver: picks up and closes follow-ups" },
  { role: "family", person: "Priya", label: "Family: sees whether today is on track" },
] as const;

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
    navigate(me?.isElder ? "/elder" : "/home");
  }

  return (
    <Shell title="Sign in to Relay">
      <p className="-mt-4 mb-6 text-lg">
        Just exploring?{" "}
        <a href="#explore-heading" className="font-bold text-brand underline underline-offset-4">
          Try the interactive demo
        </a>
        . No account needed.
      </p>
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

      <section aria-labelledby="explore-heading" className="mt-12 rounded-lg bg-oat p-6">
        <h2 id="explore-heading" className="font-display text-3xl">
          Just exploring Relay?
        </h2>
        <p className="mt-2 text-lg">
          Try the interactive demo. No account required. These are simulated, fictional people, not real accounts, and nothing you do there is saved.
        </p>
        <ul className="mt-5 grid gap-3">
          {DEMO_SHORTCUTS.map((d) => (
            <li key={d.role}>
              <Link
                to={`/demo?role=${d.role}`}
                className="group flex min-h-16 items-center gap-4 rounded-md border-2 border-line-strong bg-surface px-4 py-3 no-underline hover:border-brand"
              >
                <span aria-hidden="true" className={`grid size-12 shrink-0 place-items-center rounded-full font-display text-2xl text-brand-ink ${d.role === "elder" ? "bg-terracotta" : "bg-brand"}`}>
                  {d.person.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-display text-2xl leading-tight text-ink">{d.person}</span>
                  <span className="block text-base text-muted">{d.label}</span>
                </span>
                <span className="font-bold text-brand group-hover:underline">Open demo</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </Shell>
  );
}
