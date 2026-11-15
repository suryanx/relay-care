import { Link, Navigate } from "react-router";
import { Card, Shell } from "../components/ui";
import { useSession } from "../lib/session";

const roleLabel = { admin: "Family administrator", caregiver: "Caregiver", elder: "Elder" } as const;

export default function Home() {
  const { me } = useSession();
  if (!me) return <Navigate to="/sign-in" replace />;
  if (me.isElder) return <Navigate to="/elder" replace />;

  return (
    <Shell title="Your care profiles" wide>
      {me.memberships.length === 0 ? (
        <Card>
          <p className="mb-4">You are not part of any care profile yet.</p>
          <Link to="/profiles/new" className="inline-block rounded-lg bg-brand px-5 py-3 font-bold text-brand-ink">
            Create a care profile
          </Link>
        </Card>
      ) : (
        <>
          <ul className="mb-6 grid gap-4 sm:grid-cols-2">
            {me.memberships.map((p) => (
              <li key={p.id}>
                <Link to={`/profiles/${p.id}`} className="block rounded-xl border border-line bg-surface p-5 shadow-sm hover:border-brand">
                  <span className="block text-xl font-bold">{p.fullName}</span>
                  <span className="block text-muted">
                    {roleLabel[p.role]} · {p.timezone}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <Link to="/profiles/new" className="font-bold text-brand underline">
            Create another care profile
          </Link>
        </>
      )}
    </Shell>
  );
}
