import { useState } from "react";
import { Navigate, useParams } from "react-router";
import type { ScheduleResponse } from "../../shared/schemas";
import { ProfileNav } from "../components/ProfileNav";
import { EmptyState, FormError, Shell } from "../components/ui";
import { formatDate, formatTime, todayIn } from "../lib/format";
import { useSession } from "../lib/session";
import { useApi } from "../lib/useApi";
import { useProfile } from "../lib/useProfile";

const statusLabel: Record<string, string> = {
  scheduled: "Planned",
  taken: "Taken",
  not_taken: "Not taken",
  unconfirmed: "Unconfirmed",
};

export default function Schedule() {
  const { profileId = "" } = useParams();
  const { me } = useSession();
  const profile = useProfile(profileId);
  const [offset, setOffset] = useState(0);
  const tz = profile.data?.timezone;
  const date = tz ? todayIn(tz, offset) : null;
  const sched = useApi<ScheduleResponse>(date ? `/profiles/${profileId}/schedule?date=${date}` : null);

  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;

  return (
    <Shell title="Schedule" eyebrow={profile.data?.fullName} wide nav={<ProfileNav profileId={profileId} name={profile.data?.preferredName} />}>
      <FormError message={profile.error ?? sched.error} />
      <div role="group" aria-label="Choose day" className="mb-6 flex gap-2">
        {["Today", "Tomorrow"].map((label, i) => (
          <button
            key={label}
            type="button"
            aria-pressed={offset === i}
            onClick={() => setOffset(i)}
            className={`min-h-11 rounded-lg border-2 px-4 font-bold ${offset === i ? "border-brand bg-brand text-brand-ink" : "border-line bg-surface"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {date && <h2 className="mb-1 text-xl font-bold">{formatDate(date)}</h2>}
      {tz && <p className="mb-4 text-sm text-muted">Times shown in {tz}.</p>}
      {sched.data === null && !sched.error && <p role="status">Loading schedule…</p>}
      {sched.data?.items.length === 0 && <EmptyState>Nothing planned for this day.</EmptyState>}
      <ol className="space-y-2">
        {sched.data?.items.map((i) => (
          <li key={i.id} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4 sm:gap-4">
            <span className="w-14 shrink-0 text-lg font-bold sm:w-20">{formatTime(i.localTime)}</span>
            <div className="min-w-0 flex-1">
              <span
                className={`mb-1 inline-block rounded-full px-2.5 py-0.5 text-xs font-bold ${
                  i.kind === "medication" ? "bg-brand text-brand-ink" : "border border-line bg-canvas text-ink"
                }`}
              >
                {i.kind === "medication" ? "Medicine" : "Routine"}
              </span>
              <p className="font-bold">{i.label}</p>
              {i.detail && <p className="text-sm text-muted">{i.detail}</p>}
              <p className="sr-only">Status: {statusLabel[i.status] ?? i.status}</p>
            </div>
          </li>
        ))}
      </ol>
    </Shell>
  );
}
