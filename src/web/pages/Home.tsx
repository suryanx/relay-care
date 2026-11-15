import { Link, Navigate } from "react-router";
import type { AdherenceResponse, FollowUpSummary, ProfileSummary } from "../../shared/schemas";
import { EmptyState, LinkButton, Loading, Pill, Shell } from "../components/ui";
import { useSession } from "../lib/session";
import { useApi } from "../lib/useApi";

const roleLabel = { admin: "Family administrator", caregiver: "Caregiver", elder: "Elder" } as const;

function greetingFor(name: string) {
  const h = new Date().getHours();
  const first = name.split(" ")[0];
  if (h >= 5 && h < 12) return `Good morning, ${first}`;
  if (h >= 12 && h < 17) return `Good afternoon, ${first}`;
  return `Good evening, ${first}`;
}

/** Signed-in home for family administrators and caregivers: who you care for, and what needs you. */
export default function Home() {
  const { me } = useSession();
  const followUps = useApi<FollowUpSummary[]>(me && !me.isElder ? "/follow-ups/summary" : null);
  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;

  const totalOpen = followUps.data?.reduce((n, f) => n + f.open, 0) ?? 0;
  const totalMine = followUps.data?.reduce((n, f) => n + f.mine, 0) ?? 0;

  return (
    <Shell title={greetingFor(me.user.name)} wide>
      <p className="-mt-4 mb-10 max-w-2xl text-xl text-muted">
        {followUps.data === null
          ? "Checking what needs attention…"
          : totalOpen + totalMine === 0
            ? "Nothing is waiting for you right now."
            : [totalOpen ? `${totalOpen} follow-up${totalOpen === 1 ? " is" : "s are"} waiting for someone` : null, totalMine ? `${totalMine} with you` : null]
                .filter(Boolean)
                .join(", and ") + "."}
      </p>

      <h2 className="mb-5 font-display text-3xl font-medium">Who you care for</h2>
      {me.memberships.length === 0 ? (
        <EmptyState>
          You are not part of a care circle yet. Create one for the person you help, or ask their family administrator for an invitation.
        </EmptyState>
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {me.memberships.map((p) => (
            <ProfileCard key={p.id} profile={p} summary={followUps.data?.find((f) => f.profileId === p.id)} />
          ))}
        </ul>
      )}
      <div className="mt-10">
        <LinkButton to="/profiles/new" variant="secondary">
          Create a care profile
        </LinkButton>
      </div>
    </Shell>
  );
}

function ProfileCard({ profile, summary }: { profile: ProfileSummary; summary?: FollowUpSummary }) {
  const today = useApi<AdherenceResponse>(`/profiles/${profile.id}/adherence`);
  const c = today.data?.counts;
  return (
    <li>
      <Link
        to={summary && summary.open > 0 ? `/profiles/${profile.id}/follow-ups` : `/profiles/${profile.id}`}
        className="group flex h-full flex-col rounded-lg border border-line bg-surface p-6 no-underline shadow-[var(--shadow-paper)] transition-colors hover:border-brand"
      >
        <div className="flex items-center gap-4">
          <span aria-hidden="true" className="grid size-16 shrink-0 place-items-center rounded-full bg-brand font-display text-3xl text-brand-ink">
            {profile.preferredName.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <p className="truncate font-display text-2xl text-ink">{profile.preferredName}</p>
            <p className="text-base text-muted">{roleLabel[profile.role]}</p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {summary && summary.open > 0 ? (
            <Pill tone="attention" symbol="!" size="sm">
              {summary.open} follow-up{summary.open === 1 ? "" : "s"} waiting
            </Pill>
          ) : (
            <Pill tone="good" symbol="✓" size="sm">
              No follow-ups waiting
            </Pill>
          )}
          {summary && summary.mine > 0 && (
            <Pill tone="brand" size="sm">
              {summary.mine} with you
            </Pill>
          )}
          {summary && summary.claimed - summary.mine > 0 && (
            <Pill tone="neutral" symbol="→" size="sm">
              {summary.claimed - summary.mine} being handled
            </Pill>
          )}
        </div>
        {c ? (
          <p className="mt-4 text-base text-muted">
            Today: <span className="num font-bold text-ink">{c.taken}</span> taken, <span className="num font-bold text-ink">{c.pending}</span> to come
            {c.unconfirmed > 0 && (
              <>
                , <span className="num font-bold text-attention">{c.unconfirmed}</span> unconfirmed
              </>
            )}
            {c.notTaken > 0 && (
              <>
                , <span className="num font-bold text-ink">{c.notTaken}</span> not taken
              </>
            )}
          </p>
        ) : (
          <div className="mt-2">
            <Loading label="Loading today…" />
          </div>
        )}
        <span className="mt-auto pt-5 font-bold text-brand group-hover:underline">Open {profile.preferredName}’s care</span>
      </Link>
    </li>
  );
}
