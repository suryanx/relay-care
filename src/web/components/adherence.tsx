import { useState, type FormEvent } from "react";
import type { AdherenceCountsView, DoseEventView, DoseView, SourceValue } from "../../shared/schemas";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { formatTime } from "../lib/format";
import { FormError, SecondaryButton } from "./ui";

export const SOURCE_LABEL: Record<SourceValue, string> = {
  self_reported: "Self-reported",
  observed: "Observed by care team",
  reported_by_other: "Reported to care team",
  system: "Automatic",
};

const PHASE_LABEL: Record<DoseView["phase"], { text: string; symbol: string; cls: string }> = {
  upcoming: { text: "Upcoming", symbol: "○", cls: "border-line bg-canvas" },
  due: { text: "Due", symbol: "●", cls: "border-amber-700 bg-amber-50 text-amber-900" },
  unconfirmed: { text: "Unconfirmed", symbol: "?", cls: "border-amber-700 bg-amber-50 text-amber-900" },
  taken: { text: "Taken", symbol: "✓", cls: "border-brand bg-emerald-50 text-brand" },
  not_taken: { text: "Not taken", symbol: "–", cls: "border-ink bg-surface" },
  void: { text: "Removed", symbol: "×", cls: "border-line text-muted" },
};

export function PhaseChip({ phase }: { phase: DoseView["phase"] }) {
  const p = PHASE_LABEL[phase];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border-2 px-2.5 py-0.5 text-sm font-bold ${p.cls}`}>
      <span aria-hidden="true">{p.symbol}</span>
      {p.text}
    </span>
  );
}

/** Never shows "missed": Not taken (explicit) and Unconfirmed (unknown) are always separate. */
export function CountsGrid({ counts }: { counts: AdherenceCountsView }) {
  const cells = [
    { label: "Taken", value: counts.taken, hint: "Confirmed" },
    { label: "Not taken", value: counts.notTaken, hint: "Reported" },
    { label: "Unconfirmed", value: counts.unconfirmed, hint: "No answer yet" },
    { label: "Still to come", value: counts.pending, hint: "Not yet due or due now" },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label} className="rounded-xl border border-line bg-canvas p-3">
          <dt className="text-sm font-bold text-muted">{c.label}</dt>
          <dd className="text-3xl font-bold">{c.value}</dd>
          <dd className="text-xs text-muted">{c.hint}</dd>
        </div>
      ))}
    </dl>
  );
}

export function eventSummary(e: DoseEventView): string {
  switch (e.type) {
    case "outcome":
      return `${e.actor} recorded ${e.toStatus === "taken" ? "taken" : "not taken"} (${SOURCE_LABEL[e.source].toLowerCase()})`;
    case "correction":
      return `${e.actor} corrected ${e.fromStatus.replace("_", " ")} → ${e.toStatus.replace("_", " ")}`;
    case "unconfirmed":
      return "No confirmation after the grace period — marked unconfirmed";
    case "snooze":
      return `${e.actor} asked to be reminded later`;
    case "void":
      return "Removed by a schedule change";
  }
}

const timeOf = (iso: string, tz: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", timeZone: tz }).format(new Date(iso));

/** One dose for the care team: status, provenance, and the actions allowed right now. */
export function TeamDoseRow({
  dose,
  profileId,
  timezone,
  isAdmin,
  currentUserName,
  onChanged,
}: {
  dose: DoseView;
  profileId: string;
  timezone: string;
  isAdmin: boolean;
  currentUserName: string;
  onChanged: () => void;
}) {
  const [panel, setPanel] = useState<null | "record" | "correct" | "history">(null);
  const [history, setHistory] = useState<DoseEventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/profiles/${profileId}/doses/${encodeURIComponent(dose.id)}`;
  const canCorrect = Boolean(dose.outcome) && (isAdmin || dose.outcome?.recordedBy === currentUserName);

  async function openHistory() {
    setPanel(panel === "history" ? null : "history");
    if (panel !== "history") {
      try {
        setHistory(await api<DoseEventView[]>(`${base}/events`));
      } catch (err) {
        setError(errorMessage(err));
      }
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>, kind: "outcome" | "correct") {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/${kind}`, {
        method: "POST",
        body: JSON.stringify({ outcome: f.get("outcome"), source: f.get("source"), note: f.get("note") || null }),
      });
      setPanel(null);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const idBase = dose.id.replace(/[^a-z0-9]/gi, "");
  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className="w-14 shrink-0 text-lg font-bold">{formatTime(dose.localTime)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${dose.kind === "medication" ? "bg-brand text-brand-ink" : "border border-line bg-canvas"}`}>
              {dose.kind === "medication" ? "Medicine" : "Routine"}
            </span>
            <PhaseChip phase={dose.phase} />
          </div>
          <p className="mt-1 font-bold">{dose.label}</p>
          {dose.detail && <p className="text-sm text-muted">{dose.detail}</p>}
          {dose.outcome && (
            <p className="mt-1 text-sm">
              {SOURCE_LABEL[dose.outcome.source ?? "system"]} · {dose.outcome.recordedBy ?? "unknown"}
              {dose.outcome.recordedAt && ` · recorded ${timeOf(dose.outcome.recordedAt, timezone)}`}
              {dose.outcome.occurredAt && dose.outcome.recordedAt && dose.outcome.occurredAt.slice(0, 16) !== dose.outcome.recordedAt.slice(0, 16) &&
                ` · taken ${timeOf(dose.outcome.occurredAt, timezone)}`}
              {dose.outcome.note && ` · “${dose.outcome.note}”`}
            </p>
          )}
          {dose.snoozeCount > 0 && dose.status === "scheduled" && (
            <p className="mt-1 text-sm text-muted">Asked to be reminded later ({dose.snoozeCount}×)</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {dose.canRecord && (
              <SecondaryButton aria-expanded={panel === "record"} onClick={() => setPanel(panel === "record" ? null : "record")}>
                Record outcome<span className="sr-only"> for {dose.label} at {dose.localTime}</span>
              </SecondaryButton>
            )}
            {canCorrect && (
              <SecondaryButton aria-expanded={panel === "correct"} onClick={() => setPanel(panel === "correct" ? null : "correct")}>
                Correct<span className="sr-only"> {dose.label} at {dose.localTime}</span>
              </SecondaryButton>
            )}
            <SecondaryButton aria-expanded={panel === "history"} onClick={openHistory}>
              History<span className="sr-only"> of {dose.label} at {dose.localTime}</span>
            </SecondaryButton>
          </div>
        </div>
      </div>

      <FormError message={error} />

      {(panel === "record" || panel === "correct") && (
        <form onSubmit={(e) => submit(e, panel === "record" ? "outcome" : "correct")} className="mt-4 rounded-lg bg-canvas p-4">
          <fieldset className="mb-3">
            <legend className="font-bold">{panel === "record" ? "What happened?" : "Correct to"}</legend>
            {(["taken", "not_taken"] as const)
              .filter((o) => panel === "record" || o !== dose.status)
              .map((o, i) => (
                <label key={o} className="mr-6 inline-flex min-h-11 items-center gap-2">
                  <input type="radio" name="outcome" value={o} required defaultChecked={i === 0} className="size-5" />
                  {o === "taken" ? "Taken" : "Not taken"}
                </label>
              ))}
          </fieldset>
          <fieldset className="mb-3">
            <legend className="font-bold">How do you know?</legend>
            <label className="mr-6 inline-flex min-h-11 items-center gap-2">
              <input type="radio" name="source" value="observed" required defaultChecked className="size-5" />I saw it
            </label>
            <label className="inline-flex min-h-11 items-center gap-2">
              <input type="radio" name="source" value="reported_by_other" className="size-5" />I was told
            </label>
          </fieldset>
          <label htmlFor={`${idBase}-${panel}-note`} className="block font-bold">
            {panel === "correct" ? "Reason for correction (required)" : "Note (optional)"}
          </label>
          <input
            id={`${idBase}-${panel}-note`}
            name="note"
            required={panel === "correct"}
            minLength={panel === "correct" ? 3 : undefined}
            maxLength={500}
            className="mb-3 w-full rounded-lg border-2 border-line bg-surface px-3 py-2"
          />
          <button type="submit" disabled={busy} className="min-h-11 rounded-lg bg-brand px-4 font-bold text-brand-ink disabled:opacity-60">
            {busy ? "Saving…" : panel === "record" ? "Save outcome" : "Save correction"}
          </button>
        </form>
      )}

      {panel === "history" && (
        <div className="mt-4 rounded-lg bg-canvas p-4">
          <h3 className="mb-2 font-bold">History</h3>
          {history === null ? (
            <p role="status">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-muted">Nothing recorded yet.</p>
          ) : (
            <ol className="space-y-1 text-sm">
              {history.map((e) => (
                <li key={e.id}>
                  <span className="font-bold">{timeOf(e.recordedAt, timezone)}</span> — {eventSummary(e)}
                  {e.note && <span className="text-muted"> · “{e.note}”</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}
