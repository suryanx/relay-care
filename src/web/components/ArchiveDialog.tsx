import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { Button, DangerButton, Field, FormError } from "./ui";

/**
 * Accessible confirmation for archiving a care circle (native <dialog>: focus is trapped, Escape closes).
 * Uses the existing archive API, which re-checks administrator rights, recent sign-in and the typed name.
 */
export function ArchiveDialog({
  profile,
  open,
  onClose,
  onArchived,
}: {
  profile: { id: string; preferredName: string };
  open: boolean;
  onClose: () => void;
  onArchived: () => void | Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      d.querySelector<HTMLInputElement>('input[name="confirmName"]')?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const confirmName = String(new FormData(e.currentTarget).get("confirmName") ?? "");
    setBusy(true);
    setError(null);
    try {
      await api(`/profiles/${profile.id}/archive`, { method: "POST", body: JSON.stringify({ confirmName }) });
      await onArchived();
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.body.code === "REAUTH_REQUIRED"
          ? "For your security, please sign out and sign in again, then retry within 15 minutes."
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }

  const titleId = `archive-title-${profile.id}`;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-ink/40"
    >
      <form onSubmit={submit} className="p-6 sm:p-7">
        <h2 id={titleId} className="font-display text-3xl leading-tight">
          Archive {profile.preferredName}’s care profile?
        </h2>
        <ul className="mt-4 list-disc space-y-1.5 pl-6 text-lg">
          <li>It will be hidden for you and every caregiver, and {profile.preferredName}’s device will be signed out.</li>
          <li>Reminder emails stop.</li>
          <li>
            All care records are <strong>kept</strong>: medicines, appointments and history. You can restore it from “Archived care circles”.
          </li>
        </ul>
        <div className="mt-5">
          <FormError message={error} />
          {open && <Field label={`Type “${profile.preferredName}” to confirm`} name="confirmName" required autoComplete="off" />}
        </div>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <DangerButton type="submit" busy={busy}>
            Archive care profile
          </DangerButton>
        </div>
      </form>
    </dialog>
  );
}
