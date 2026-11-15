import { useState, type FormEvent } from "react";
import { Navigate, useParams } from "react-router";
import type { IncidentListResponse, IncidentView } from "../../shared/schemas";
import { ProfileNav } from "../components/ProfileNav";
import { EmptyState, FormError, SecondaryButton, Shell } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { useSession } from "../lib/session";
import { useApi } from "../lib/useApi";
import { useProfile } from "../lib/useProfile";

const RESOLUTION_LABEL: Record<string, string> = {
  taken_confirmed: "Medicine was taken",
  not_taken_confirmed: "Medicine was not taken",
  unable_to_verify: "Could not verify",
  help_addressed: "Help given / sorted out",
  reconciled: "Closed automatically — the dose was confirmed later",
};

const EVENT_LABEL: Record<string, string> = {
  created: "Follow-up opened",
  claimed: "is checking on this",
  released: "released it back to the team",
  resolved: "resolved it",
  cancelled: "Closed",
  reconciled: "Closed automatically",
};

const fmt = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

export default function FollowUps() {
  const { profileId = "" } = useParams();
  const { me } = useSession();
  const profile = useProfile(profileId);
  const list = useApi<IncidentListResponse>(me && !me.isElder ? `/profiles/${profileId}/incidents` : null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;

  async function act(path: string, body: object, success: string) {
    setError(null);
    setNotice(null);
    try {
      await api(`/profiles/${profileId}/incidents/${path}`, { method: "POST", body: JSON.stringify(body) });
      setNotice(success);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : errorMessage(err));
    } finally {
      list.reload();
    }
  }

  const items = list.data?.incidents ?? [];
  const open = items.filter((i) => i.status === "open");
  const mine = items.filter((i) => i.status === "claimed" && i.claimedByMe);
  const others = items.filter((i) => i.status === "claimed" && !i.claimedByMe);
  const closed = items.filter((i) => i.status === "resolved" || i.status === "cancelled");
  const name = profile.data?.preferredName ?? "them";

  return (
    <Shell title="Follow-ups" eyebrow={profile.data?.fullName} wide nav={<ProfileNav profileId={profileId} name={profile.data?.preferredName} role={profile.data?.role} />}>
      <p className="mb-4 text-muted">
        Things that need a person to check. Say “I’ll check on this” so the rest of the team knows it is in hand. Relay is not an emergency
        service.
      </p>
      <FormError message={error ?? list.error} />
      <p role="status" aria-live="polite" className={notice ? "mb-4 rounded-lg border-2 border-brand bg-emerald-50 p-3 font-bold" : "sr-only"}>
        {notice}
      </p>
      {list.data === null && !list.error && <p role="status">Loading…</p>}
      {list.data && (
        <>
      <Section title={`Needs someone (${open.length})`} empty="Nothing waiting. Thank you.">
        {open.map((i) => (
          <IncidentCard key={i.id} i={i}>
            <button
              type="button"
              onClick={() => act(`${i.id}/claim`, {}, `You are now checking on: ${i.subject}`)}
              className="min-h-12 rounded-lg bg-brand px-5 font-bold text-brand-ink"
            >
              I’ll check on this<span className="sr-only"> — {i.subject}</span>
            </button>
          </IncidentCard>
        ))}
      </Section>

      <Section title={`I’m checking (${mine.length})`} empty="You are not handling anything right now.">
        {mine.map((i) => (
          <IncidentCard key={i.id} i={i}>
            <ResolveForm i={i} elderName={name} onResolve={(body) => act(`${i.id}/resolve`, body, "Thank you — recorded and closed.")} />
            <SecondaryButton onClick={() => act(`${i.id}/release`, {}, "Released back to the team.")} className="mt-2">
              I can’t do this — release it
            </SecondaryButton>
          </IncidentCard>
        ))}
      </Section>

      <Section title={`Being handled by others (${others.length})`} empty="No one else is handling anything.">
        {others.map((i) => (
          <IncidentCard key={i.id} i={i}>
            {i.canRelease && (
              <SecondaryButton onClick={() => act(`${i.id}/release`, { note: "Released by family administrator" }, "Released back to the team.")}>
                Release (administrator)
              </SecondaryButton>
            )}
            {i.canResolve && <ResolveForm i={i} elderName={name} onResolve={(body) => act(`${i.id}/resolve`, body, "Recorded and closed.")} />}
          </IncidentCard>
        ))}
      </Section>

      <Section title="Recently closed" empty="Nothing closed in the last two days.">
        {closed.map((i) => (
          <IncidentCard key={i.id} i={i} />
        ))}
      </Section>
        </>
      )}
    </Shell>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xl font-bold">{title}</h2>
      {children.length === 0 ? <EmptyState>{empty}</EmptyState> : <ul className="space-y-3">{children}</ul>}
    </section>
  );
}

function IncidentCard({ i, children }: { i: IncidentView; children?: React.ReactNode }) {
  const [showHistory, setShowHistory] = useState(false);
  return (
    <li className={`rounded-xl border-2 bg-surface p-4 ${i.priority === "high" && i.status === "open" ? "border-amber-700" : "border-line"}`}>
      <div className="flex flex-wrap items-center gap-2">
        {i.priority === "high" && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-sm font-bold text-amber-950">High priority</span>}
        <span className="text-sm text-muted">{i.reason} · {fmt(i.createdAt)}</span>
      </div>
      <p className="mt-1 text-lg font-bold">{i.subject}</p>
      {i.status === "claimed" && (
        <p className="mt-1">
          <strong>{i.claimedByMe ? "You are" : `${i.claimedBy?.name} is`}</strong> checking on this{i.claimedAt ? ` (since ${fmt(i.claimedAt)})` : ""}.
        </p>
      )}
      {(i.status === "resolved" || i.status === "cancelled") && (
        <p className="mt-1">
          {i.resolution ? RESOLUTION_LABEL[i.resolution] : "Closed"}
          {i.resolvedBy ? ` — by ${i.resolvedBy}` : ""}
          {i.resolutionNote ? ` · “${i.resolutionNote}”` : ""}
        </p>
      )}
      {children && <div className="mt-3">{children}</div>}
      <button type="button" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)} className="mt-2 min-h-11 text-sm font-bold text-brand underline">
        {showHistory ? "Hide" : "Show"} activity<span className="sr-only"> for {i.subject}</span>
      </button>
      {showHistory && (
        <ol className="mt-1 space-y-1 border-l-2 border-line pl-3 text-sm">
          {i.events.map((e) => (
            <li key={e.id}>
              <span className="font-bold">{fmt(e.recordedAt)}</span> —{" "}
              {e.type === "claimed" || e.type === "released" || e.type === "resolved" ? `${e.actor} ${EVENT_LABEL[e.type]}` : EVENT_LABEL[e.type]}
              {e.note ? ` · ${e.note}` : ""}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

function ResolveForm({ i, elderName, onResolve }: { i: IncidentView; elderName: string; onResolve: (body: object) => Promise<void> }) {
  const [resolution, setResolution] = useState(i.allowedResolutions[0]!);
  const [busy, setBusy] = useState(false);
  const needsSource = resolution === "taken_confirmed" || resolution === "not_taken_confirmed";
  const idBase = `r-${i.id}`;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    await onResolve({ resolution, source: needsSource ? f.get("source") : undefined, note: f.get("note") || null });
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="rounded-lg bg-canvas p-3">
      <fieldset className="mb-2">
        <legend className="font-bold">What did you find?</legend>
        {i.allowedResolutions.map((r) => (
          <label key={r} className="flex min-h-11 items-center gap-2">
            <input type="radio" name="resolution" value={r} checked={resolution === r} onChange={() => setResolution(r)} className="size-5 shrink-0" />
            {RESOLUTION_LABEL[r]}
          </label>
        ))}
      </fieldset>
      {needsSource && (
        <fieldset className="mb-2">
          <legend className="font-bold">How do you know?</legend>
          <label className="mr-6 inline-flex min-h-11 items-center gap-2">
            <input type="radio" name="source" value="observed" defaultChecked className="size-5" />I saw it
          </label>
          <label className="inline-flex min-h-11 items-center gap-2">
            <input type="radio" name="source" value="reported_by_other" className="size-5" />
            {elderName} or someone told me
          </label>
        </fieldset>
      )}
      <label htmlFor={`${idBase}-note`} className="block font-bold">
        Note (optional)
      </label>
      <input id={`${idBase}-note`} name="note" maxLength={500} className="mb-3 w-full rounded-lg border-2 border-line bg-surface px-3 py-2" />
      <button type="submit" disabled={busy} className="min-h-12 rounded-lg bg-brand px-5 font-bold text-brand-ink disabled:opacity-60">
        {busy ? "Saving…" : "Record and close"}
      </button>
    </form>
  );
}
