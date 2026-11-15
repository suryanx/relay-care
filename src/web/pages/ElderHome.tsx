import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import { Shell } from "../components/ui";
import { api } from "../lib/api";
import { useSession } from "../lib/session";

interface ElderHomeData {
  preferredName: string;
  timezone: string;
}

function greeting(name: string, timeZone: string, now: Date): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  if (hour >= 5 && hour < 12) return `Good morning, ${name}`;
  if (hour >= 12 && hour < 17) return `Good afternoon, ${name}`;
  if (hour >= 17 && hour < 21) return `Good evening, ${name}`;
  return `Good night, ${name}. Have a peaceful sleep.`;
}

/** Placeholder for the elder's daily dashboard (full design in a later checkpoint). */
export default function ElderHome() {
  const { me } = useSession();
  const [data, setData] = useState<ElderHomeData | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (me?.isElder) void api<ElderHomeData>("/elder/home").then(setData);
  }, [me]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!me) return <Navigate to="/sign-in" replace />;
  if (!me.isElder) return <Navigate to="/" replace />;
  if (!data) return <p role="status" className="p-8 text-2xl">Loading…</p>;

  const dateLine = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZone: data.timezone,
  }).format(now);

  return (
    <Shell title={greeting(data.preferredName, data.timezone, now)}>
      <p className="mb-8 text-2xl">{dateLine}</p>
      <section aria-labelledby="next-heading" className="rounded-2xl border border-line bg-surface p-6 text-xl">
        <h2 id="next-heading" className="mb-2 text-2xl font-bold">
          Today
        </h2>
        <p>Your medicines and appointments will appear here.</p>
      </section>
    </Shell>
  );
}
