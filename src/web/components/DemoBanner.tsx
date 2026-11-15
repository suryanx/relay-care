import { useState } from "react";
import { api } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { useSession } from "../lib/session";

export const DEMO_PEOPLE = [
  { role: "elder", person: "Swastik", label: "Elder" },
  { role: "caregiver", person: "Ravi", label: "Caregiver" },
  { role: "family", person: "Priya", label: "Family" },
] as const;

/** Starts (or switches) the interactive demo inside the visitor's own synthetic care circle. */
export async function openDemo(role: (typeof DEMO_PEOPLE)[number]["role"]) {
  const res = await api<{ redirect: string }>("/demo/start", { method: "POST", body: JSON.stringify({ role }) });
  window.location.assign(res.redirect); // full load so the new session is picked up everywhere
}

/** Shown only to demo personas: makes it unmistakable that this is synthetic data, and lets them switch. */
export function DemoBanner() {
  const { me } = useSession();
  const [busy, setBusy] = useState(false);
  if (!me?.demo) return null;

  async function end() {
    setBusy(true);
    await api("/demo/end", { method: "POST", body: "{}" }).catch(() => {});
    await authClient.signOut();
    window.location.assign("/sign-in");
  }

  return (
    <div role="region" aria-label="Demo" className="w-full border-b border-attention/30 bg-attention-soft">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
        <p className="text-base">
          <strong>Interactive demo</strong> with synthetic data, private to you. Nothing is real or emailed.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base text-muted">View as:</span>
          {DEMO_PEOPLE.map((d) => (
            <button
              key={d.role}
              type="button"
              disabled={busy}
              aria-current={me.demo === d.role ? "true" : undefined}
              onClick={() => {
                setBusy(true);
                openDemo(d.role).catch(() => setBusy(false));
              }}
              className={`min-h-11 rounded-md px-3 font-bold ${me.demo === d.role ? "bg-brand text-brand-ink" : "bg-surface text-ink hover:bg-oat"}`}
            >
              {d.person}
              <span className="sr-only">, {d.label}</span>
            </button>
          ))}
          <button type="button" disabled={busy} onClick={end} className="min-h-11 px-2 font-bold text-attention underline underline-offset-4">
            End demo
          </button>
        </div>
      </div>
    </div>
  );
}
