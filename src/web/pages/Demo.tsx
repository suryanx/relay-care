import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Logo, Pill, buttonClass } from "../components/ui";

/**
 * Read-only guided preview with invented people and data. It talks to no API, shares no credentials and cannot
 * change anything — so it is safe on a public deployment. Buttons are visibly disabled and say why.
 */
type View = "family" | "caregiver" | "elder";

const VIEWS: { id: View; label: string; who: string }[] = [
  { id: "elder", label: "Swastik’s screen", who: "The person being cared for" },
  { id: "caregiver", label: "Ravi’s follow-ups", who: "Caregiver" },
  { id: "family", label: "Priya’s overview", who: "Family administrator" },
];

export default function Demo() {
  const [view, setView] = useState<View>("elder");
  useEffect(() => {
    document.title = "Explore the demo · Relay";
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="w-full border-b border-line">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Logo />
          <div className="flex flex-wrap gap-3">
            <Link to="/sign-in" className={buttonClass("secondary", "sm")}>
              Sign in
            </Link>
            <Link to="/register" className={buttonClass("primary", "sm")}>
              Set up a care circle
            </Link>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 pb-20 pt-8 sm:px-6">
        <div role="note" className="mb-8 rounded-lg border-l-4 border-terracotta bg-attention-soft p-4 text-lg">
          <strong>A fictional preview.</strong> Swastik, Priya and Ravi are invented, and so is every medicine and time. Buttons are switched off here, so nothing
          can be changed. To try the real workflow, set up your own care circle.
        </div>

        <h1 className="font-display text-4xl font-medium sm:text-5xl">One morning with Relay</h1>
        <p className="mt-3 max-w-2xl text-xl text-muted">
          At 08:00 Swastik’s medicine is due. By 09:00 nobody has confirmed it, so Relay marks it unconfirmed, not missed, and opens a follow-up. Ravi takes it on.
        </p>

        <div role="tablist" aria-label="Whose view" className="mt-8 flex flex-wrap gap-2">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              id={`tab-${v.id}`}
              aria-selected={view === v.id}
              aria-controls={`panel-${v.id}`}
              onClick={() => setView(v.id)}
              className={`min-h-12 rounded-md border-2 px-4 text-left font-bold ${view === v.id ? "border-brand bg-brand text-brand-ink" : "border-line-strong bg-surface text-ink hover:border-brand"}`}
            >
              {v.label}
              <span className={`block text-sm font-normal ${view === v.id ? "text-brand-soft" : "text-muted"}`}>{v.who}</span>
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`panel-${view}`} aria-labelledby={`tab-${view}`} className="mt-8">
          {view === "elder" && <ElderPreview />}
          {view === "caregiver" && <CaregiverPreview />}
          {view === "family" && <FamilyPreview />}
        </div>
      </main>
    </div>
  );
}

function Disabled({ children, variant = "primary" }: { children: ReactNode; variant?: "primary" | "secondary" }) {
  return (
    <button type="button" disabled aria-disabled="true" title="Disabled in the demo" className={buttonClass(variant, "lg", "w-full")}>
      {children}
    </button>
  );
}

function Frame({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure>
      <div className="rounded-lg border border-line bg-surface p-5 shadow-[var(--shadow-paper)] sm:p-8">{children}</div>
      <figcaption className="mt-3 text-base text-muted">{caption}</figcaption>
    </figure>
  );
}

function ElderPreview() {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <Frame caption="What Swastik sees on his own phone. No menus, no settings: just today.">
        <p className="font-display text-4xl">Good morning, Swastik</p>
        <p className="num mt-2 text-xl text-muted">Sunday 15 November · 08:04</p>
        <div className="mt-6 rounded-lg bg-oat p-5">
          <p className="font-bold text-muted">Your medicine now</p>
          <p className="num mt-1 text-5xl text-brand">08:00</p>
          <p className="mt-2 font-display text-2xl">Morning medicine</p>
          <p className="text-lg">One tablet after breakfast</p>
          <div className="mt-5 grid gap-3">
            <Disabled>✓ I have taken it</Disabled>
            <Disabled variant="secondary">Remind me later</Disabled>
            <Disabled variant="secondary">I did not take it</Disabled>
          </div>
        </div>
        <button type="button" disabled className={buttonClass("secondary", "lg", "mt-4 w-full border-attention text-attention")}>
          I need help
        </button>
      </Frame>
      <div className="space-y-5 text-lg">
        <h2 className="font-display text-3xl">Designed for one decision at a time</h2>
        <p>Large text, one medicine at a time, and plain words. “Remind me later” postpones the reminder, never the prescribed time, and can be used twice.</p>
        <p>
          “I did not take it” is recorded as reported, with no advice about doubling or skipping. “I need help” tells the care team in Relay; the screen also says
          Relay is not an emergency service.
        </p>
      </div>
    </div>
  );
}

function CaregiverPreview() {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <Frame caption="Ravi’s follow-ups. Meera, the other caregiver, sees “Ravi is checking on this”.">
        <h2 className="font-display text-2xl">Needs someone</h2>
        <div className="mt-3 rounded-md border-2 border-attention/50 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="attention" symbol="!" size="sm">
              High priority
            </Pill>
            <span className="text-muted">The person asked for help</span>
          </div>
          <p className="mt-2 text-xl font-bold">Asked for help: “I feel a little dizzy”</p>
          <button type="button" disabled className={buttonClass("primary", "md", "mt-3")}>
            I’ll check on this
          </button>
        </div>
        <h2 className="mt-8 font-display text-2xl">I’m checking</h2>
        <div className="mt-3 rounded-md border border-line p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="attention" symbol="?" size="sm">
              Unconfirmed
            </Pill>
            <span className="text-muted">No one has confirmed a medicine yet</span>
          </div>
          <p className="mt-2 text-xl font-bold">
            Morning medicine at <span className="num">08:00</span>
          </p>
          <fieldset disabled className="mt-3 space-y-2">
            <legend className="font-bold">What did you find?</legend>
            {["Medicine was taken", "Medicine was not taken", "Could not verify"].map((l, i) => (
              <label key={l} className="flex min-h-11 items-center gap-2">
                <input type="radio" name="demo-res" defaultChecked={i === 0} className="size-5" />
                {l}
              </label>
            ))}
          </fieldset>
        </div>
      </Frame>
      <div className="space-y-5 text-lg">
        <h2 className="font-display text-3xl">Exactly one person checks</h2>
        <p>“I’ll check on this” is claimed on the server: if two caregivers tap at once, one gets it and the other is told who has it.</p>
        <p>Recording “taken” goes into the same history as Swastik’s own taps, with how Ravi knows: he saw it, or was told.</p>
      </div>
    </div>
  );
}

function FamilyPreview() {
  const counts = [
    ["Taken", "1", "good", "✓"],
    ["Not taken", "0", "neutral", "–"],
    ["Unconfirmed", "1", "attention", "?"],
    ["Still to come", "2", "neutral", "○"],
  ] as const;
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <Frame caption="Priya’s overview for Swastik. Not taken and unconfirmed are always counted separately.">
        <h2 className="font-display text-2xl">Today’s medicines</h2>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {counts.map(([label, n, tone, sym]) => (
            <div key={label} className="rounded-md bg-oat p-4">
              <dt className="flex items-center gap-1.5 text-base font-bold text-muted">
                <span aria-hidden="true">{sym}</span>
                {label}
              </dt>
              <dd className={`num mt-1 text-4xl ${tone === "attention" ? "text-attention" : tone === "good" ? "text-brand" : "text-ink"}`}>{n}</dd>
            </div>
          ))}
        </dl>
        <h2 className="mt-8 font-display text-2xl">Recent activity</h2>
        <ol className="mt-3 space-y-2 border-l-2 border-line pl-4 text-lg">
          <li>
            <span className="num font-bold">09:00</span> Morning medicine marked unconfirmed after the grace period
          </li>
          <li>
            <span className="num font-bold">09:06</span> Ravi is checking on this
          </li>
          <li>
            <span className="num font-bold">09:20</span> Ravi recorded taken (he was told by Swastik)
          </li>
        </ol>
      </Frame>
      <div className="space-y-5 text-lg">
        <h2 className="font-display text-3xl">Oversight without hovering</h2>
        <p>Priya sees who handled each issue and the full history, invites or removes caregivers, and reviews email reminders before any are sent.</p>
        <p>Emails never contain medicine names. They point back to Relay, where access is checked.</p>
      </div>
    </div>
  );
}
