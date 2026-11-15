import { useEffect } from "react";
import { Link } from "react-router";
import { Logo, buttonClass } from "../components/ui";
import { useSession } from "../lib/session";

/** Public front door. Every link goes somewhere real; no claims beyond what Relay does today. */
export default function Landing() {
  const { me } = useSession();
  const dashboard = me ? (me.isElder ? "/elder" : "/home") : null;

  useEffect(() => {
    document.title = "Relay — shared care for medicines, appointments and the people who help";
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:p-3 focus:font-bold">
        Skip to main content
      </a>
      <header className="w-full">
        <nav aria-label="Main" className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-5 sm:px-6">
          <Logo />
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-base font-bold">
            <li className="hidden md:block">
              <a href="#how" className="text-ink underline-offset-4 hover:underline">
                How it works
              </a>
            </li>
            <li>
              <Link to="/demo" className="text-ink underline-offset-4 hover:underline">
                Explore demo
              </Link>
            </li>
            {dashboard ? (
              <li>
                <Link to={dashboard} className={buttonClass("primary", "sm")}>
                  Open my dashboard
                </Link>
              </li>
            ) : (
              <>
                <li>
                  <Link to="/sign-in" className="text-ink underline-offset-4 hover:underline">
                    Sign in
                  </Link>
                </li>
                <li>
                  <Link to="/register" className={buttonClass("primary", "sm")}>
                    Get started
                  </Link>
                </li>
              </>
            )}
          </ul>
        </nav>
      </header>

      <main id="main" className="flex-1">
        {/* Hero */}
        <section className="mx-auto grid w-full max-w-7xl items-center gap-12 px-4 pb-20 pt-10 sm:px-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:pb-28 lg:pt-16">
          <div>
            <h1 className="font-display text-[2.6rem] font-medium leading-[1.05] tracking-tight text-ink sm:text-6xl lg:text-[4.4rem]">
              <span className="block">A little more care.</span>
              <span className="block">A lot more peace of mind.</span>
            </h1>
            <p className="mt-7 max-w-xl text-xl leading-relaxed text-muted">
              Relay keeps an older person’s medicines, appointments and daily routines in one shared place, for them and for the family and caregivers who help.
              When a dose hasn’t been confirmed, everyone can see who is checking.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link to={dashboard ?? "/register"} className={buttonClass("primary", "lg")}>
                {dashboard ? "Open my dashboard" : "Get started"}
              </Link>
              <Link to="/demo" className={buttonClass("secondary", "lg")}>
                Explore the demo
              </Link>
            </div>
            <p className="mt-5 text-base text-muted">The demo uses invented people and data. Nothing you click there changes anything.</p>
          </div>
          <HeroPreview />
        </section>

        {/* How it works — a real sequence, so it is numbered */}
        <section id="how" aria-labelledby="how-heading" className="border-y border-line bg-oat">
          <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6">
            <h2 id="how-heading" className="max-w-2xl font-display text-4xl font-medium leading-tight sm:text-5xl">
              How Relay works
            </h2>
            <ol className="mt-12 grid gap-10 md:grid-cols-3">
              {[
                ["Plan", "A family administrator enters medicines exactly as prescribed, along with appointments and simple daily routines. Times follow the older person’s own time zone."],
                ["Confirm", "At each dose time, the older person taps “I have taken it” or “I did not take it”, or asks to be reminded later. A family member can record it too, and says how they know."],
                ["Coordinate", "If nobody confirms a dose, Relay calls it unconfirmed, not missed, and opens a follow-up. One caregiver says “I’ll check on this”, and everyone else can see it’s being handled."],
              ].map(([title, body], i) => (
                <li key={title} className="border-t-2 border-brand pt-5">
                  <span className="num font-display text-5xl text-terracotta" aria-hidden="true">
                    {i + 1}
                  </span>
                  <h3 className="mt-3 font-display text-2xl font-medium">{title}</h3>
                  <p className="mt-2 text-lg leading-relaxed text-muted">{body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Roles */}
        <section aria-labelledby="roles-heading" className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6">
          <h2 id="roles-heading" className="max-w-2xl font-display text-4xl font-medium leading-tight sm:text-5xl">
            Each person sees what they need
          </h2>
          <div className="mt-12 grid gap-x-10 gap-y-12 md:grid-cols-3">
            <Role
              who="The person being cared for"
              lead="A calm screen with today’s medicines and four large buttons."
              items={["I have taken it", "Remind me later", "I did not take it", "I need help"]}
            />
            <Role
              who="Family administrator"
              lead="Sets everything up and keeps an overview."
              items={["Medicines, routines and appointments", "Invites caregivers, removes access", "Sees who handled each issue", "Email reminder history"]}
            />
            <Role
              who="Caregiver"
              lead="Has their own sign-in, and only sees the people they help."
              items={["Open follow-ups", "“I’ll check on this”", "Records what they found", "Today’s schedule"]}
            />
          </div>
        </section>

        {/* The idea */}
        <section aria-labelledby="idea-heading" className="bg-brand text-brand-ink">
          <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:items-center">
            <div>
              <h2 id="idea-heading" className="font-display text-4xl font-medium leading-tight sm:text-5xl">
                Unconfirmed is not the same as missed.
              </h2>
              <p className="mt-6 max-w-xl text-xl leading-relaxed text-brand-soft">
                Most reminder apps treat silence as a missed dose. Usually the medicine was taken and nobody tapped a button. Relay keeps those apart, so families
                check in calmly instead of panicking, and only one person needs to make the call.
              </p>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
              {[
                ["✓", "Taken", "Someone confirmed it, and Relay records who and how they know."],
                ["–", "Not taken", "Someone said it was not taken. Reported, never assumed."],
                ["?", "Unconfirmed", "No answer after the grace period. A follow-up opens."],
                ["○", "Scheduled", "Coming up later today."],
              ].map(([symbol, label, text]) => (
                <div key={label} className="rounded-lg bg-white/[0.07] p-5 ring-1 ring-white/15">
                  <dt className="flex items-center gap-2 font-display text-2xl">
                    <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-canvas text-lg text-brand">
                      {symbol}
                    </span>
                    {label}
                  </dt>
                  <dd className="mt-2 text-lg text-brand-soft">{text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* Trust */}
        <section aria-labelledby="trust-heading" className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6">
          <h2 id="trust-heading" className="max-w-2xl font-display text-4xl font-medium leading-tight sm:text-5xl">
            Built to be trusted with someone’s day
          </h2>
          <ul className="mt-12 grid gap-x-10 gap-y-8 md:grid-cols-2">
            {[
              ["Access by role", "Caregivers only see the people they’re invited to help, and losing access takes effect immediately. Every permission is checked on the server."],
              ["A record you can follow", "Every confirmation, correction and follow-up is kept in an append-only history with who did it and how they knew."],
              ["Readable by design", "Large type, high contrast, generous touch targets, full keyboard use and plain language on the older person’s screen."],
              ["No clinical advice", "Relay never suggests, changes or skips a dose. Instructions come from the prescriber, entered by a person. It is not an emergency service."],
            ].map(([title, body]) => (
              <li key={title}>
                <h3 className="font-display text-2xl font-medium">{title}</h3>
                <p className="mt-2 max-w-xl text-lg leading-relaxed text-muted">{body}</p>
              </li>
            ))}
          </ul>
          <div className="mt-14 flex flex-wrap gap-3">
            <Link to={dashboard ?? "/register"} className={buttonClass("primary", "lg")}>
              {dashboard ? "Open my dashboard" : "Set up a care circle"}
            </Link>
            <Link to="/demo" className={buttonClass("secondary", "lg")}>
              Explore the demo
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-oat">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-start md:justify-between">
          <div className="max-w-md">
            <Logo />
            <p className="mt-3 text-base text-muted">
              Relay helps families coordinate care. It does not give medical advice and is not an emergency service. In an emergency, call your local emergency
              number.
            </p>
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-base font-bold">
            <li>
              <a href="#how" className="underline-offset-4 hover:underline">
                How it works
              </a>
            </li>
            <li>
              <Link to="/demo" className="underline-offset-4 hover:underline">
                Demo
              </Link>
            </li>
            <li>
              <Link to="/sign-in" className="underline-offset-4 hover:underline">
                Sign in
              </Link>
            </li>
            <li>
              <Link to="/register" className="underline-offset-4 hover:underline">
                Get started
              </Link>
            </li>
          </ul>
        </div>
        <p className="mx-auto w-full max-w-7xl px-4 pb-8 text-sm text-muted sm:px-6">Built for the Catalyst Solo AI Hackathon 2026.</p>
      </footer>
    </div>
  );
}

function Role({ who, lead, items }: { who: string; lead: string; items: string[] }) {
  return (
    <div>
      <h3 className="font-display text-2xl font-medium">{who}</h3>
      <p className="mt-2 text-lg text-muted">{lead}</p>
      <ul className="mt-4 space-y-2">
        {items.map((i) => (
          <li key={i} className="flex gap-3 text-lg">
            <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-terracotta" />
            {i}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The one bold element: the relay hand-off line linking the three people, beside an honest example card. */
function HeroPreview() {
  return (
    <figure className="relative" aria-label="Example: an unconfirmed medicine that a caregiver is checking">
      <svg viewBox="0 0 520 120" className="mb-2 w-full" aria-hidden="true">
        <path
          className="relay-line"
          style={{ ["--relay-length" as string]: "500" }}
          d="M24 92 C 120 8, 200 112, 260 60 S 400 8, 496 40"
          fill="none"
          stroke="var(--color-brand)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <circle cx="24" cy="92" r="9" fill="var(--color-terracotta)" />
        <circle cx="260" cy="60" r="9" fill="var(--color-brand)" />
        <circle cx="496" cy="40" r="9" fill="var(--color-brand)" />
      </svg>
      <div className="mb-4 grid grid-cols-3 text-base font-bold">
        <span>Swastik</span>
        <span className="text-center">Ravi, caregiver</span>
        <span className="text-right">Priya, family</span>
      </div>

      <div className="rounded-lg border border-line bg-surface p-6 shadow-[var(--shadow-paper)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="num text-4xl text-brand">08:00</p>
            <p className="mt-1 font-display text-2xl">Morning medicine</p>
            <p className="text-lg text-muted">One tablet after breakfast</p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-attention/40 bg-attention-soft px-3 py-1 font-bold text-attention">
            <span aria-hidden="true">?</span> Unconfirmed
          </span>
        </div>
        <p className="mt-4 text-lg">No one has confirmed this yet. That doesn’t mean it was missed.</p>
        <div className="mt-5 flex items-center gap-3 rounded-md bg-brand-soft p-4">
          <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-brand font-display text-lg text-brand-ink">
            R
          </span>
          <p className="text-lg">
            <strong>Ravi</strong> is checking on this. The rest of the family can see it’s in hand.
          </p>
        </div>
      </div>
      <figcaption className="mt-3 text-base text-muted">Example with invented names.</figcaption>
    </figure>
  );
}
