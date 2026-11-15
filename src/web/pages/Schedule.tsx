import { useState } from "react";
import { Navigate, useParams } from "react-router";
import type { AdherenceResponse } from "../../shared/schemas";
import { CountsGrid, TeamDoseRow } from "../components/adherence";
import { ProfileNav } from "../components/ProfileNav";
import { Card, EmptyState, FormError, Shell } from "../components/ui";
import { formatDate, todayIn } from "../lib/format";
import { useSession } from "../lib/session";
import { useApi } from "../lib/useApi";
import { useProfile } from "../lib/useProfile";

export default function Schedule() {
  const { profileId = "" } = useParams();
  const { me } = useSession();
  const profile = useProfile(profileId);
  const [offset, setOffset] = useState(0);
  const tz = profile.data?.timezone;
  const date = tz ? todayIn(tz, offset) : null;
  const sched = useApi<AdherenceResponse>(date ? `/profiles/${profileId}/adherence?date=${date}` : null);

  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;

  const days = [
    { label: "Yesterday", value: -1 },
    { label: "Today", value: 0 },
    { label: "Tomorrow", value: 1 },
  ];

  return (
    <Shell title="Schedule" eyebrow={profile.data?.fullName} wide nav={<ProfileNav profileId={profileId} name={profile.data?.preferredName} />}>
      <FormError message={profile.error ?? sched.error} />
      <div role="group" aria-label="Choose day" className="mb-6 flex flex-wrap gap-2">
        {days.map((d) => (
          <button
            key={d.label}
            type="button"
            aria-pressed={offset === d.value}
            onClick={() => setOffset(d.value)}
            className={`min-h-11 rounded-lg border-2 px-4 font-bold ${offset === d.value ? "border-brand bg-brand text-brand-ink" : "border-line bg-surface"}`}
          >
            {d.label}
          </button>
        ))}
      </div>
      {date && <h2 className="mb-1 text-xl font-bold">{formatDate(date)}</h2>}
      {tz && <p className="mb-4 text-sm text-muted">Times shown in {tz}. Unconfirmed means nobody has answered yet — it does not mean the dose was missed.</p>}

      {sched.data && (
        <Card>
          <h3 className="mb-3 font-bold">Medicines on this day</h3>
          <CountsGrid counts={sched.data.counts} />
        </Card>
      )}

      {sched.data === null && !sched.error && <p role="status">Loading schedule…</p>}
      {sched.data?.doses.length === 0 && <EmptyState>Nothing planned for this day.</EmptyState>}
      <ol className="space-y-2">
        {sched.data?.doses.map((d) => (
          <TeamDoseRow
            key={d.id}
            dose={d}
            profileId={profileId}
            timezone={sched.data!.timezone}
            isAdmin={profile.data?.role === "admin"}
            currentUserName={me.user.name}
            onChanged={sched.reload}
          />
        ))}
      </ol>
    </Shell>
  );
}
