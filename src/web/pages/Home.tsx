import { useState } from "react";
import { Link, Navigate } from "react-router";
import type { AdherenceResponse, ArchivedProfile, FollowUpSummary, ProfileSummary } from "../../shared/schemas";
import { ArchiveDialog } from "../components/ArchiveDialog";
import { EmptyState, FormError, LinkButton, Loading, Pill, SecondaryButton, Shell } from "../components/ui";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { useSession } from "../lib/session";
import { useApi } from "../lib/useApi";

const roleLabel = { admin: "Family administrator", caregiver: "Caregiver", elder: "Elder" } as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Signed-in home: the people this account helps care for. Identity and per-circle role are always explicit. */
export default function Home() {
  const { me, refresh } = useSession();
  const followUps = useApi<FollowUpSummary[]>(me && !me.isElder ? "/follow-ups/summary" : null);
  const archived = useApi<ArchivedProfile[]>(me && !me.isElder ? "/profiles-archived" : null);
  const [error, setError] = useState<string | null>(null);
  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;

  async function restore(id: string) {
    setError(null);
    try {
      await api(`/profiles/${id}/restore`, { method: "POST", body: "{}" });
      archived.reload();
      followUps.reload();
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const waiting = followUps.data?.reduce((n, f) => n + f.open, 0) ?? 0;
  const mine = followUps.data?.reduce((n, f) => n + f.mine, 0) ?? 0;
  const parts = [
    waiting ? `${plural(waiting, "follow-up needs", "follow-ups need")} someone to check` : null,
    mine ? `you are checking ${plural(mine, "item", "items")}` : null,
  ].filter(Boolean) as string[];
  const summaryLine =
    followUps.data === null
      ? "Checking what needs attention…"
      : parts.length === 0
        ? "Nothing is waiting for anyone right now."
        : `${parts.join(", and ").replace(/^./, (c) => c.toUpperCase())}.`;

  return (
    <Shell title="People you care for" eyebrow={`Signed in as ${me.user.name}`} wide>
      <p className="-mt-4 mb-2 max-w-2xl text-xl text-muted">Choose a person to see their day, medicines and follow-ups.</p>
      <p className="mb-10 max-w-2xl text-lg">{summaryLine}</p>
      <FormError message={error} />

      {me.memberships.length === 0 ? (
        <EmptyState>
          You are not part of a care circle yet. Set one up for the person you help, or ask their family administrator for an invitation.
        </EmptyState>
      ) : (
        <ul className={`grid gap-5 ${me.memberships.length === 1 ? "max-w-md" : "sm:grid-cols-2 lg:grid-cols-3"}`}>
          {me.memberships.map((p) => (
            <ProfileCard
              key={p.id}
              profile={p}
              summary={followUps.data?.find((f) => f.profileId === p.id)}
              onArchived={async () => {
                await refresh();
                archived.reload();
                followUps.reload();
              }}
            />
          ))}
        </ul>
      )}
      <div className="mt-10">
        <LinkButton to="/profiles/new" variant="secondary">
          Set up care for someone new
        </LinkButton>
      </div>

      {archived.data && archived.data.length > 0 && (
        <details className="mt-12 rounded-lg border border-line bg-surface">
          <summary className="flex min-h-14 cursor-pointer items-center px-5 font-display text-2xl">Archived care circles ({archived.data.length})</summary>
          <ul className="divide-y divide-line px-5 pb-4">
            {archived.data.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span>
                  <strong>{a.preferredName}</strong>{" "}
                  <span className="text-muted">
                    ({a.fullName}), archived {new Date(a.archivedAt).toLocaleDateString()}
                  </span>
                </span>
                <SecondaryButton onClick={() => restore(a.id)}>
                  Restore<span className="sr-only"> {a.preferredName}</span>
                </SecondaryButton>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Shell>
  );
}

function ProfileCard({ profile, summary, onArchived }: { profile: ProfileSummary; summary?: FollowUpSummary; onArchived: () => Promise<void> }) {
  const today = useApi<AdherenceResponse>(`/profiles/${profile.id}/adherence`);
  const c = today.data?.counts;
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const menuId = `manage-${profile.id}`;
  return (
    <li className="relative">
      {/* Manage menu sits beside (not inside) the card link, so both stay valid, focusable controls. */}
      {profile.role === "admin" && (
        <div
          className="absolute right-3 top-3 z-10"
          onKeyDown={(e) => {
            if (e.key === "Escape") setMenuOpen(false);
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMenuOpen(false);
          }}
        >
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((o) => !o)}
            className="grid size-11 place-items-center rounded-full text-2xl leading-none text-muted hover:bg-oat hover:text-ink"
          >
            <span aria-hidden="true">⋯</span>
            <span className="sr-only">Manage {profile.preferredName}’s care profile</span>
          </button>
          {menuOpen && (
            <ul id={menuId} role="menu" aria-label={`Manage ${profile.preferredName}’s care profile`} className="absolute right-0 mt-1 w-60 rounded-md border border-line bg-surface p-1 shadow-lg">
              <li role="none">
                <Link role="menuitem" to={`/profiles/${profile.id}`} className="flex min-h-11 items-center rounded px-3 font-bold text-ink no-underline hover:bg-oat">
                  Open care profile
                </Link>
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  autoFocus
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirming(true);
                  }}
                  className="flex min-h-11 w-full items-center rounded px-3 text-left font-bold text-danger hover:bg-danger-soft"
                >
                  Archive care profile…
                </button>
              </li>
            </ul>
          )}
          <ArchiveDialog profile={profile} open={confirming} onClose={() => setConfirming(false)} onArchived={onArchived} />
        </div>
      )}
      <Link
        to={summary && summary.open > 0 ? `/profiles/${profile.id}/follow-ups` : `/profiles/${profile.id}`}
        className="group flex h-full flex-col rounded-lg border border-line bg-surface p-6 no-underline shadow-[var(--shadow-paper)] transition-colors hover:border-brand"
      >
        <div className="flex items-center gap-4">
          <span aria-hidden="true" className="grid size-16 shrink-0 place-items-center rounded-full bg-brand font-display text-3xl text-brand-ink">
            {profile.preferredName.slice(0, 1)}
          </span>
          <div className="min-w-0 pr-10">
            <p className="text-base text-muted">Caring for</p>
            <p className="truncate font-display text-3xl leading-tight text-ink">{profile.preferredName}</p>
          </div>
        </div>
        <p className="mt-4 text-base">
          Your role: <strong>{roleLabel[profile.role]}</strong>
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {summary && summary.open > 0 ? (
            <Pill tone="attention" symbol="!" size="sm">
              {plural(summary.open, "follow-up needs", "follow-ups need")} someone
            </Pill>
          ) : summary && summary.claimed > 0 ? (
            <Pill tone="brand" symbol="→" size="sm">
              {plural(summary.claimed, "follow-up is", "follow-ups are")} being checked
            </Pill>
          ) : summary ? (
            <Pill tone="good" symbol="✓" size="sm">
              No open follow-ups
            </Pill>
          ) : null}
          {summary && summary.mine > 0 && (
            <Pill tone="brand" size="sm">
              You are checking {plural(summary.mine, "item", "items")}
            </Pill>
          )}
        </div>
        {c ? (
          <p className="mt-4 text-base text-muted">
            Today’s medicines: <span className="num font-bold text-ink">{c.taken}</span> taken, <span className="num font-bold text-ink">{c.pending}</span> still to come
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
            .
          </p>
        ) : (
          <div className="mt-2">
            <Loading label="Loading today…" />
          </div>
        )}
        <span className="mt-auto pt-5 font-bold text-brand group-hover:underline">View {profile.preferredName}’s care</span>
      </Link>
    </li>
  );
}
