import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import type { InvitationPreview } from "../../shared/schemas";
import { Card, Field, FormError, PrimaryButton, Shell } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { useSession } from "../lib/session";

const STATE_MESSAGE: Record<string, string> = {
  invalid: "This invitation link is not valid. Please ask the family administrator for a new one.",
  accepted: "This invitation has already been used.",
  revoked: "This invitation was cancelled by the family administrator.",
  expired: "This invitation has expired. Please ask for a new one.",
};

/** /invite#<token> — the token stays in the URL fragment, so it is never sent to the server in logs or Referer. */
export default function Invite() {
  const navigate = useNavigate();
  const { me, refresh } = useSession();
  const [token] = useState(() => window.location.hash.slice(1));
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [mode, setMode] = useState<"register" | "signin">("register");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const load = token ? api<InvitationPreview>("/invitations/preview", { method: "POST", body: JSON.stringify({ token }) }) : Promise.resolve({ state: "invalid" as const });
    load.then(
      (p) => active && setPreview(p),
      () => active && setPreview({ state: "invalid" }),
    );
    return () => {
      active = false;
    };
  }, [token]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ profileId: string }>("/invitations/accept", { method: "POST", body: JSON.stringify({ token }) });
      await refresh();
      history.replaceState(null, "", "/invite"); // drop the token from the address bar
      navigate(`/profiles/${res.profileId}/follow-ups`);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : "Could not accept the invitation.");
    } finally {
      setBusy(false);
    }
  }

  async function authenticate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password"));
    setBusy(true);
    setError(null);
    const email = preview?.invitedEmail ?? "";
    const result =
      mode === "register"
        ? await authClient.signUp.email({ name: String(f.get("name")).trim(), email, password })
        : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (result.error) {
      setError(result.error.status === 429 ? "Too many attempts. Please wait a minute." : (result.error.message ?? "That did not work. Please check and try again."));
      return;
    }
    await refresh();
  }

  if (!preview) {
    return (
      <Shell title="Care team invitation">
        <p role="status">Checking your invitation…</p>
      </Shell>
    );
  }
  if (preview.state !== "pending") {
    return (
      <Shell title="Care team invitation">
        <FormError message={STATE_MESSAGE[preview.state] ?? STATE_MESSAGE.invalid!} />
      </Shell>
    );
  }

  return (
    <Shell title={`Join ${preview.careRecipient}’s care team`}>
      <p className="mb-6">
        <strong>{preview.invitedBy}</strong> invited <strong>{preview.invitedEmailMasked}</strong> to help care for {preview.careRecipient} as a caregiver.
        You will use your own account and passcode.
      </p>
      <FormError message={error} />
      {me && !me.isElder ? (
        <Card>
          <p className="mb-4">
            Signed in as <strong>{me.user.email}</strong>.
          </p>
          <PrimaryButton type="button" busy={busy} onClick={accept}>
            Accept invitation
          </PrimaryButton>
        </Card>
      ) : (
        <Card>
          <fieldset className="mb-4">
            <legend className="mb-2 font-bold">Do you already have a Relay account?</legend>
            <label className="mr-6 inline-flex min-h-11 items-center gap-2">
              <input type="radio" name="mode" checked={mode === "register"} onChange={() => setMode("register")} className="size-5" />
              No, create one
            </label>
            <label className="inline-flex min-h-11 items-center gap-2">
              <input type="radio" name="mode" checked={mode === "signin"} onChange={() => setMode("signin")} className="size-5" />
              Yes, sign in
            </label>
          </fieldset>
          <form onSubmit={authenticate}>
            <Field label="Email" name="email" type="email" value={preview.invitedEmail ?? ""} readOnly hint="The invitation is for this address." />
            {mode === "register" && <Field label="Your name" name="name" required maxLength={80} autoComplete="name" />}
            <Field
              label={mode === "register" ? "Choose a passcode" : "Passcode"}
              name="password"
              type="password"
              required
              minLength={mode === "register" ? 10 : undefined}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              hint={mode === "register" ? "At least 10 characters." : undefined}
            />
            <PrimaryButton type="submit" busy={busy}>
              {mode === "register" ? "Create account" : "Sign in"}
            </PrimaryButton>
          </form>
        </Card>
      )}
    </Shell>
  );
}
