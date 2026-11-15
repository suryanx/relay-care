import { useState } from "react";
import { Navigate, useParams } from "react-router";
import type {
  NotificationCenterResponse,
  NotificationItem,
  NotificationPreferences,
  NotificationStatusValue,
  NotificationTypeValue,
  SweepSummaryView,
} from "../../shared/schemas";
import { ProfileNav } from "../components/ProfileNav";
import { Card, EmptyState, FormError, Shell } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { useSession } from "../lib/session";
import { useApi } from "../lib/useApi";
import { useProfile } from "../lib/useProfile";

const TYPE_LABEL: Record<NotificationTypeValue, string> = {
  dose_reminder: "Medicine reminder",
  dose_snooze_reminder: "Reminder again (after “remind me later”)",
  dose_unconfirmed: "Unconfirmed medicine alert",
  dose_not_taken: "Reported not taken",
  appointment_reminder: "Appointment reminder",
  help_request: "Help request",
};

/** Honest labels: nothing here ever claims inbox delivery. */
const STATUS_LABEL: Record<NotificationStatusValue, { text: string; symbol: string; cls: string }> = {
  queued: { text: "Queued", symbol: "…", cls: "border-line bg-canvas" },
  sending: { text: "Sending", symbol: "→", cls: "border-line bg-canvas" },
  accepted: { text: "Accepted by email provider", symbol: "✓", cls: "border-brand bg-emerald-50 text-brand" },
  previewed: { text: "Preview only — not sent", symbol: "◇", cls: "border-line bg-surface" },
  failed: { text: "Failed", symbol: "!", cls: "border-danger bg-surface text-danger" },
  uncertain: { text: "Outcome unknown — not retried", symbol: "?", cls: "border-amber-700 bg-amber-50 text-amber-900" },
  paused_limit: { text: "Held — sending limit reached", symbol: "‖", cls: "border-amber-700 bg-amber-50 text-amber-900" },
  cancelled: { text: "Cancelled", symbol: "×", cls: "border-line bg-canvas text-muted" },
};

const CANCEL_REASON: Record<string, string> = {
  expired: "no longer relevant (time passed)",
  dose_removed: "the medicine schedule changed",
  dose_taken: "the dose was already confirmed",
  dose_not_taken: "the dose was already reported",
  dose_void: "the dose was removed",
  superseded_by_snooze: "replaced by a “remind me later” reminder",
  now_taken: "confirmed as taken before sending",
  now_not_taken: "reported before sending",
  corrected_to_taken: "corrected to taken before sending",
  appointment_cancelled: "the appointment was cancelled",
  appointment_rescheduled: "the appointment was moved",
  help_resolved: "the help request was closed",
  recipient_not_eligible: "recipient turned this off or left the care team",
};

const fmt = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

function describeRun(s: SweepSummaryView): string {
  const parts = [
    s.queued ? `${s.queued} new` : null,
    s.previewed ? `${s.previewed} previewed (not sent)` : null,
    s.accepted ? `${s.accepted} accepted by the email provider` : null,
    s.cancelled ? `${s.cancelled} cancelled as no longer relevant` : null,
    s.retryScheduled ? `${s.retryScheduled} will retry` : null,
    s.failed ? `${s.failed} failed` : null,
    s.uncertain ? `${s.uncertain} with unknown outcome` : null,
    s.pausedLimit ? `${s.pausedLimit} held by the sending limit` : null,
    s.markedUnconfirmed ? `${s.markedUnconfirmed} dose(s) marked unconfirmed` : null,
  ].filter(Boolean);
  return parts.length ? `Check complete: ${parts.join(", ")}.` : "Check complete: nothing is due right now.";
}

export default function Notifications() {
  const { profileId = "" } = useParams();
  const { me } = useSession();
  const profile = useProfile(profileId);
  const team = Boolean(me && !me.isElder);
  const center = useApi<NotificationCenterResponse>(team ? `/profiles/${profileId}/notifications` : null);
  const prefs = useApi<NotificationPreferences>(team ? `/profiles/${profileId}/notification-preferences` : null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;

  async function runCheck() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const s = await api<SweepSummaryView>(`/profiles/${profileId}/notifications/run-check`, { method: "POST", body: "{}" });
      setResult(describeRun(s));
      center.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  async function savePref(key: keyof NotificationPreferences, value: boolean) {
    if (!prefs.data) return;
    setError(null);
    try {
      await api(`/profiles/${profileId}/notification-preferences`, { method: "PUT", body: JSON.stringify({ ...prefs.data, [key]: value }) });
      prefs.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const data = center.data;
  return (
    <Shell title="Notifications" eyebrow={profile.data?.fullName} wide nav={<ProfileNav profileId={profileId} name={profile.data?.preferredName} role={profile.data?.role} />}>
      <FormError message={error ?? (center.error ? `${center.error} Only family administrators can view notification history.` : null)} />

      {data && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold">Email reminders</h2>
              {data.mode === "preview" ? (
                <p className="mt-1">
                  <strong>Preview mode.</strong> Reminders are prepared and listed here, but no email leaves Relay.
                </p>
              ) : (
                <p className="mt-1">
                  <strong>Real email is on.</strong> {data.realSendsUsed} of {data.realSendCap} allowed sends used.
                </p>
              )}
              <p className="mt-1 text-sm text-muted">
                “Accepted” means the email provider accepted the message. It does not confirm it reached the inbox.
              </p>
              {data.lastRun && <p className="mt-1 text-sm text-muted">Last check: {fmt(data.lastRun.startedAt)} ({data.lastRun.trigger === "manual" ? "manual" : "automatic"})</p>}
            </div>
            <button
              type="button"
              onClick={runCheck}
              disabled={running}
              aria-busy={running || undefined}
              className="min-h-12 rounded-lg bg-brand px-5 py-3 font-bold text-brand-ink disabled:opacity-60"
            >
              {running ? "Checking…" : "Run reminder check now"}
            </button>
          </div>
          <p role="status" aria-live="polite" className={result ? "mt-4 rounded-lg bg-canvas p-3 font-bold" : "sr-only"}>
            {result}
          </p>
        </Card>
      )}

      {prefs.data && (
        <Card>
          <fieldset>
            <legend className="mb-2 text-lg font-bold">Emails I receive for {profile.data?.preferredName ?? "this person"}</legend>
            {(
              [
                ["notifyDoseReminders", "Medicine reminders"],
                ["notifyAlerts", "Unconfirmed / not-taken alerts and help requests"],
                ["notifyAppointments", "Appointment reminders"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex min-h-11 items-center gap-3">
                <input type="checkbox" checked={prefs.data![key]} onChange={(e) => savePref(key, e.target.checked)} className="size-5 shrink-0" />
                {label}
              </label>
            ))}
          </fieldset>
        </Card>
      )}

      <h2 className="mb-3 mt-8 text-xl font-bold">History</h2>
      {center.data === null && !center.error && <p role="status">Loading…</p>}
      {data?.items.length === 0 && <EmptyState>No notifications yet. Run a reminder check to see what is due.</EmptyState>}
      <ul className="space-y-3">
        {data?.items.map((n) => <NotificationCard key={n.id} n={n} />)}
      </ul>
    </Shell>
  );
}

function NotificationCard({ n }: { n: NotificationItem }) {
  const s = STATUS_LABEL[n.status];
  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">{TYPE_LABEL[n.type]}</span>
        <span className={`inline-flex items-center gap-1 rounded-full border-2 px-2.5 py-0.5 text-sm font-bold ${s.cls}`}>
          <span aria-hidden="true">{s.symbol}</span>
          {s.text}
        </span>
      </div>
      <p className="mt-1">{n.status === "queued" && n.attempts === 0 ? <span className="text-muted">Content is prepared when it is processed.</span> : n.subject}</p>
      {n.related && <p className="text-sm text-muted">About: {n.related}</p>}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
        <dt className="text-muted">To</dt>
        <dd>
          {n.recipientName} ({n.recipientMasked})
        </dd>
        <dt className="text-muted">Due</dt>
        <dd>{fmt(n.dueAt)}</dd>
        {n.sentAt && (
          <>
            <dt className="text-muted">{n.status === "previewed" ? "Previewed" : "Processed"}</dt>
            <dd>{fmt(n.sentAt)}</dd>
          </>
        )}
        {n.attempts > 0 && n.status !== "previewed" && (
          <>
            <dt className="text-muted">Attempts</dt>
            <dd>
              {n.attempts}
              {n.nextAttemptAt && ` · next try ${fmt(n.nextAttemptAt)}`}
            </dd>
          </>
        )}
        {n.cancelReason && (
          <>
            <dt className="text-muted">Why</dt>
            <dd>{CANCEL_REASON[n.cancelReason] ?? n.cancelReason}</dd>
          </>
        )}
        {n.lastError && (
          <>
            <dt className="text-muted">Detail</dt>
            <dd className="break-words">{n.lastError}</dd>
          </>
        )}
      </dl>
    </li>
  );
}
