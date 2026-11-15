import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { Logo, OptionGroup, Pill, buttonClass, type Tone } from "../components/ui";
import {
  APPOINTMENT,
  DEMO_DATE,
  DEMO_NOW,
  MAX_SNOOZES,
  beingHandled,
  counts,
  demoReducer,
  elderFocus,
  initialDemoState,
  needsAttention,
  parseDemoRole,
  resolved,
  type DemoAction,
  type DemoDose,
  type DemoFollowUp,
  type DemoState,
} from "../demo/model";

/**
 * Public demo: three fictional perspectives sharing one simulated, client-only state.
 * No API calls, no accounts, no email. Session storage only remembers progress in this tab.
 */
type Role = "elder" | "caregiver" | "family";

const ROLES: { id: Role; person: string; role: string; line: string; cta: string }[] = [
  { id: "elder", person: "Swastik", role: "The person being cared for", line: "One medicine at a time and four large buttons.", cta: "See Swastik’s screen" },
  { id: "caregiver", person: "Ravi", role: "Caregiver", line: "Picks up what needs checking and records what he found.", cta: "See Ravi’s follow-ups" },
  { id: "family", person: "Priya", role: "Family administrator", line: "Sees at a glance whether today is on track.", cta: "See Priya’s overview" },
];

const CONTEXT: Record<Role, string> = {
  elder: "This is Swastik’s own screen, the person being cared for.",
  caregiver: "This is what Ravi, one of Swastik’s caregivers, sees.",
  family: "This is what Priya, Swastik’s daughter and family administrator, sees.",
};

const STORAGE_KEY = "relay-demo-state-v1";

function loadState(): DemoState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as DemoState;
  } catch {
    /* storage unavailable: start fresh */
  }
  return initialDemoState();
}

export default function Demo() {
  const [params, setParams] = useSearchParams();
  const role = parseDemoRole(params.get("role") ?? params.get("as"));
  const [state, dispatch] = useReducer(demoReducer, undefined, loadState);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state]);

  useEffect(() => {
    document.title = role ? `${ROLES.find((r) => r.id === role)!.person}’s view · Relay demo` : "Explore the demo · Relay";
  }, [role]);

  const choose = (r: Role | null) => {
    setParams(r ? { role: r } : {});
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:p-3 focus:font-bold">
        Skip to main content
      </a>
      <header className="sticky top-0 z-20 w-full border-b border-line bg-canvas/95 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <Logo />
            <Pill tone="attention" size="sm">
              Simulated demo
            </Pill>
          </div>
          {role && (
            <nav aria-label="Switch perspective" className="order-3 w-full sm:order-none sm:w-auto">
              <ul className="flex gap-1 rounded-md bg-oat p-1">
                {ROLES.map((r) => (
                  <li key={r.id} className="flex-1 sm:flex-none">
                    <button
                      type="button"
                      aria-current={role === r.id ? "page" : undefined}
                      onClick={() => choose(r.id)}
                      className={`min-h-11 w-full rounded-[0.6rem] px-3 text-base font-bold whitespace-nowrap ${role === r.id ? "bg-brand text-brand-ink" : "text-ink hover:bg-surface"}`}
                    >
                      {r.person}
                      <span className="sr-only">, {r.role}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          <div className="flex gap-2">
            {role && (
              <button type="button" onClick={() => dispatch({ type: "reset" })} className={buttonClass("secondary", "sm")}>
                Reset demo
              </button>
            )}
            <Link to="/" className={buttonClass("quiet", "sm")}>
              Exit demo
            </Link>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 pb-20 pt-8 sm:px-6">
        {role === null ? (
          <RoleChooser onChoose={choose} />
        ) : (
          <>
            <p className="mx-auto mb-6 max-w-5xl text-base text-muted">
              {CONTEXT[role]} It is <span className="num">{DEMO_NOW}</span> on {DEMO_DATE} in this story. Actions are simulated in your browser and change
              nothing real. Switch people at the top to see each action reach everyone.
            </p>
            <Notice state={state} />
            {role === "elder" && <ElderView state={state} dispatch={dispatch} />}
            {role === "caregiver" && <CaregiverView state={state} dispatch={dispatch} />}
            {role === "family" && <FamilyView state={state} />}
          </>
        )}
      </main>
    </div>
  );
}

function RoleChooser({ onChoose }: { onChoose: (r: Role) => void }) {
  return (
    <section aria-labelledby="choose-heading" className="mx-auto max-w-5xl pt-6">
      <h1 id="choose-heading" className="font-display text-4xl font-medium leading-tight sm:text-6xl">
        Experience Relay through three perspectives.
      </h1>
      <p className="mt-5 max-w-2xl text-xl text-muted">
        A fictional morning with Swastik and the two people who help him. Pick a person to begin. Everything is simulated: nothing is saved, sent or real.
      </p>
      <ul className="mt-12 grid gap-5 md:grid-cols-3">
        {ROLES.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onChoose(r.id)}
              className="group flex h-full w-full flex-col rounded-lg border border-line bg-surface p-6 text-left shadow-[var(--shadow-paper)] hover:border-brand"
            >
              <span aria-hidden="true" className={`grid size-16 place-items-center rounded-full font-display text-3xl text-brand-ink ${r.id === "elder" ? "bg-terracotta" : "bg-brand"}`}>
                {r.person.slice(0, 1)}
              </span>
              <span className="mt-5 font-display text-3xl text-ink">{r.person}</span>
              <span className="text-lg font-bold text-muted">{r.role}</span>
              <span className="mt-3 text-lg text-ink">{r.line}</span>
              <span className="mt-auto pt-6 text-lg font-bold text-brand group-hover:underline">{r.cta}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Notice({ state }: { state: DemoState }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} role="status" aria-live="polite" className={state.notice ? "mb-6 rounded-md border-l-4 border-brand bg-brand-soft p-4 text-lg font-bold" : "sr-only"}>
      {state.notice ? `${state.notice} (Simulated.)` : ""}
    </div>
  );
}

const STATUS: Record<DemoDose["status"], { text: string; symbol: string; tone: Tone }> = {
  taken: { text: "Taken", symbol: "✓", tone: "good" },
  not_taken: { text: "Not taken", symbol: "–", tone: "neutral" },
  unconfirmed: { text: "Not confirmed yet", symbol: "?", tone: "attention" },
  due: { text: "Due now", symbol: "●", tone: "brand" },
  upcoming: { text: "Later today", symbol: "○", tone: "neutral" },
};

function DoseStatus({ d }: { d: DemoDose }) {
  const s = STATUS[d.status];
  return (
    <Pill tone={s.tone} symbol={s.symbol}>
      {s.text}
    </Pill>
  );
}

/* --------------------------------- Elder --------------------------------- */

function ElderView({ state, dispatch }: { state: DemoState; dispatch: (a: DemoAction) => void }) {
  const focus = elderFocus(state);
  const others = state.doses.filter((d) => d.id !== focus?.id);
  const big = (v: "primary" | "secondary") => buttonClass(v, "lg", "min-h-16 w-full text-2xl");
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-5xl font-medium leading-tight sm:text-6xl">Good morning, Swastik</h1>
      <p className="mt-2 text-2xl text-muted">
        {DEMO_DATE}, <span className="num">{DEMO_NOW}</span>
      </p>

      <section aria-labelledby="demo-now" className="mt-8 rounded-lg border border-line bg-surface p-6 shadow-[var(--shadow-paper)] sm:p-8">
        {focus ? (
          <>
            <h2 id="demo-now" className="text-xl font-bold text-muted">
              {focus.status === "due" ? "Your medicine now" : "Your next medicine"}
            </h2>
            <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
              <p className="num text-6xl text-brand">{focus.time}</p>
              <DoseStatus d={focus} />
            </div>
            <p className="mt-3 font-display text-4xl leading-tight">
              {focus.name} <span className="text-muted">{focus.strength}</span>
            </p>
            <p className="mt-2 text-2xl">{focus.instructions}</p>
            {focus.status === "due" ? (
              <div className="mt-8 grid gap-3">
                <button type="button" onClick={() => dispatch({ type: "elder/taken", doseId: focus.id })} className={big("primary")}>
                  <span aria-hidden="true">✓</span> I have taken it
                </button>
                <button
                  type="button"
                  disabled={focus.snoozes >= MAX_SNOOZES}
                  onClick={() => dispatch({ type: "elder/later", doseId: focus.id })}
                  className={`${big("secondary")} flex-col gap-0 py-3`}
                >
                  Remind me later
                  <span className="text-lg font-normal text-muted">
                    {focus.snoozes >= MAX_SNOOZES ? "No more reminders for this one" : `in 15 minutes, ${MAX_SNOOZES - focus.snoozes} left`}
                  </span>
                </button>
                <button type="button" onClick={() => dispatch({ type: "elder/notTaken", doseId: focus.id })} className={big("secondary")}>
                  I did not take it
                </button>
              </div>
            ) : (
              <p className="mt-6 text-xl text-muted">You can confirm this from an hour before it is due.</p>
            )}
          </>
        ) : (
          <h2 id="demo-now" className="font-display text-4xl">
            All done for today
          </h2>
        )}
      </section>

      <button
        type="button"
        onClick={() => dispatch({ type: "elder/help" })}
        className="mt-6 flex min-h-16 w-full flex-col items-center justify-center rounded-md border-2 border-attention bg-attention-soft px-5 py-3 text-2xl font-bold text-attention"
      >
        I need help
        <span className="text-lg font-normal">Lets your care team know in Relay</span>
      </button>

      <section aria-labelledby="demo-day" className="mt-12">
        <h2 id="demo-day" className="mb-4 font-display text-3xl">
          The rest of today
        </h2>
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {others.map((d) => (
            <li key={d.id} className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="num text-3xl">{d.time}</p>
                <DoseStatus d={d} />
              </div>
              <p className="mt-1 text-2xl font-bold">
                {d.name} {d.strength}
              </p>
              <p className="text-xl text-muted">{d.instructions}</p>
              {d.status === "unconfirmed" && (
                <>
                  <p className="mt-2 text-xl">If you already took this, you can still tell us.</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <button type="button" onClick={() => dispatch({ type: "elder/taken", doseId: d.id })} className={buttonClass("primary", "lg")}>
                      ✓ I took it<span className="sr-only"> — {d.name}</span>
                    </button>
                    <button type="button" onClick={() => dispatch({ type: "elder/notTaken", doseId: d.id })} className={buttonClass("secondary", "lg")}>
                      I did not take it<span className="sr-only"> — {d.name}</span>
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="demo-appt" className="mt-12 rounded-lg bg-oat p-5">
        <h2 id="demo-appt" className="font-display text-3xl">
          Next appointment
        </h2>
        <p className="num mt-2 text-xl font-bold text-brand">{APPOINTMENT.when}</p>
        <p className="text-2xl font-bold">
          {APPOINTMENT.doctor}, {APPOINTMENT.specialty}
        </p>
        <p className="text-xl text-muted">{APPOINTMENT.place}</p>
      </section>
      <p className="mt-10 text-center text-lg text-muted">Relay is not an emergency service. In an emergency, call your local emergency number.</p>
    </div>
  );
}

/* ------------------------------- Caregiver ------------------------------- */

function CaregiverView({ state, dispatch }: { state: DemoState; dispatch: (a: DemoAction) => void }) {
  const open = needsAttention(state);
  const mine = beingHandled(state).filter((f) => f.owner === "Ravi");
  const others = beingHandled(state).filter((f) => f.owner !== "Ravi");
  const closed = resolved(state);
  const c = counts(state);
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">
        <h1 className="font-display text-4xl font-medium sm:text-5xl">Good morning, Ravi</h1>
        <p className="mt-2 text-xl text-muted">
          You help care for <strong className="text-ink">Swastik</strong>. Your role: caregiver.
        </p>

        <Group title="Needs someone" count={open.length} empty="Nothing waiting. Thank you.">
          {open.map((f) => (
            <FollowCard key={f.id} f={f} tone="open">
              <button type="button" onClick={() => dispatch({ type: "caregiver/claim", followUpId: f.id })} className={buttonClass("primary", "md", "self-start")}>
                I’ll check on this
              </button>
            </FollowCard>
          ))}
        </Group>

        <Group title="I’m checking" count={mine.length} empty="You are not handling anything right now.">
          {mine.map((f) => (
            <FollowCard key={f.id} f={f} tone="mine">
              <ResolveDemo f={f} onResolve={(outcome, how) => dispatch({ type: "caregiver/resolve", followUpId: f.id, outcome, how })} />
              <button type="button" onClick={() => dispatch({ type: "caregiver/release", followUpId: f.id })} className={buttonClass("quiet", "sm", "self-start")}>
                I can’t do this — release it
              </button>
            </FollowCard>
          ))}
        </Group>

        <Group title="Being handled by others" count={others.length} empty="No one else is handling anything.">
          {others.map((f) => (
            <FollowCard key={f.id} f={f} tone="other">
              <button type="button" onClick={() => dispatch({ type: "caregiver/claim", followUpId: f.id })} className={buttonClass("secondary", "sm", "self-start")}>
                Try to take this over
              </button>
            </FollowCard>
          ))}
        </Group>

        <Group title="Recently closed" count={closed.length} empty="Nothing closed yet.">
          {closed.map((f) => (
            <FollowCard key={f.id} f={f} tone="done" />
          ))}
        </Group>
      </div>

      <aside className="space-y-6 lg:pt-4">
        <section className="rounded-lg bg-oat p-5" aria-labelledby="cg-today">
          <h2 id="cg-today" className="font-display text-2xl">
            Swastik today
          </h2>
          <ul className="mt-3 space-y-3">
            {state.doses.map((d) => (
              <li key={d.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-3">
                <span className="num text-xl">{d.time}</span>
                <span className="min-w-0">
                  <span className="block font-bold">
                    {d.name} {d.strength}
                  </span>
                  <DoseStatus d={d} />
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-base text-muted">
            <span className="num">{c.taken}</span> taken, <span className="num">{c.unconfirmed}</span> unconfirmed, <span className="num">{c.notTaken}</span> not taken,{" "}
            <span className="num">{c.toCome}</span> still to come.
          </p>
        </section>
        <section className="rounded-lg bg-oat p-5" aria-labelledby="cg-appt">
          <h2 id="cg-appt" className="font-display text-2xl">
            Next appointment
          </h2>
          <p className="num mt-2 font-bold text-brand">{APPOINTMENT.when}</p>
          <p>
            {APPOINTMENT.doctor}, {APPOINTMENT.specialty}
          </p>
        </section>
      </aside>
    </div>
  );
}

function Group({ title, count, empty, children }: { title: string; count: number; empty: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-4 font-display text-2xl">
        {title} <span className="num text-muted">({count})</span>
      </h2>
      {count === 0 ? <p className="rounded-lg bg-oat px-5 py-5 text-center text-muted">{empty}</p> : <ul className="space-y-3">{children}</ul>}
    </section>
  );
}

function FollowCard({ f, tone, children }: { f: DemoFollowUp; tone: "open" | "mine" | "other" | "done"; children?: ReactNode }) {
  const edge = { open: "border-l-terracotta", mine: "border-l-brand", other: "border-l-brand", done: "border-l-line-strong" }[tone];
  const pill = {
    open: <Pill tone="attention" symbol="!" size="sm">Needs someone</Pill>,
    mine: <Pill tone="brand" symbol="→" size="sm">You are checking</Pill>,
    other: <Pill tone="brand" symbol="→" size="sm">{`${f.owner} is checking`}</Pill>,
    done: <Pill tone="good" symbol="✓" size="sm">Closed</Pill>,
  }[tone];
  return (
    <li className={`flex flex-col gap-3 rounded-lg border border-line border-l-4 ${edge} bg-surface p-5 shadow-[var(--shadow-paper)]`}>
      <div className="flex flex-wrap items-center gap-2">
        {pill}
        {f.kind === "help" && tone !== "done" && (
          <Pill tone="attention" size="sm">
            High priority
          </Pill>
        )}
        <span className="text-base text-muted">
          Opened <span className="num">{f.openedAt}</span>
        </span>
      </div>
      <p className="font-display text-2xl leading-snug">{f.title}</p>
      {f.kind === "unconfirmed" && tone !== "done" && <p className="text-lg text-muted">No answer after the grace period. That does not mean it was missed.</p>}
      {f.outcome && <p className="text-lg">{f.outcome}</p>}
      {children}
    </li>
  );
}

function ResolveDemo({ f, onResolve }: { f: DemoFollowUp; onResolve: (o: "taken" | "not_taken" | "unable" | "helped", how?: "seen" | "told") => void }) {
  const options: { id: "taken" | "not_taken" | "unable" | "helped"; label: string }[] =
    f.kind === "help"
      ? [
          { id: "helped", label: "Help given / sorted out" },
          { id: "unable", label: "Could not verify" },
        ]
      : [
          { id: "taken", label: "Medicine was taken" },
          { id: "not_taken", label: "Medicine was not taken" },
          { id: "unable", label: "Could not verify" },
        ];
  const [outcome, setOutcome] = useState(options[0]!.id);
  const [how, setHow] = useState<"seen" | "told">("told");
  const needsHow = outcome !== "unable";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onResolve(outcome, needsHow ? how : undefined);
      }}
      className="grid gap-4 rounded-md bg-oat p-4 md:grid-cols-2"
    >
      <OptionGroup legend="What did you find?" name={`o-${f.id}`} value={outcome} onChange={(v) => setOutcome(v as typeof outcome)} options={options} />
      {needsHow ? (
        <OptionGroup
          legend="How do you know?"
          name={`h-${f.id}`}
          value={how}
          onChange={(v) => setHow(v as "seen" | "told")}
          options={[
            { id: "seen", label: "I saw it" },
            { id: "told", label: "Swastik or someone told me" },
          ]}
        />
      ) : (
        <p className="self-center text-lg text-muted">The dose stays unconfirmed. Nothing is marked as taken.</p>
      )}
      <button type="submit" className={buttonClass("primary", "md", "md:col-span-2 md:justify-self-start")}>
        Record and close
      </button>
    </form>
  );
}

/* --------------------------------- Family -------------------------------- */

function FamilyView({ state }: { state: DemoState }) {
  const c = counts(state);
  const open = needsAttention(state);
  const handled = beingHandled(state);
  const next = state.doses.find((d) => d.status === "due" || d.status === "upcoming");
  const headline =
    open.length > 0
      ? `${open.length} ${open.length === 1 ? "thing needs" : "things need"} someone to check`
      : handled.length > 0
        ? "Nothing is waiting. Open issues are being checked."
        : c.unconfirmed + c.notTaken > 0
          ? "Nothing is waiting, but not every dose was taken today."
          : "Today is on track.";
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">
        <h1 className="font-display text-4xl font-medium sm:text-5xl">Good morning, Priya</h1>
        <p className="mt-2 text-xl text-muted">Swastik’s day so far. Your role: family administrator.</p>

        <section aria-labelledby="fam-status" className={`mt-8 rounded-lg border-l-4 p-6 ${open.length ? "border-terracotta bg-attention-soft" : "border-brand bg-brand-soft"}`}>
          <h2 id="fam-status" className="font-display text-3xl">
            {headline}
          </h2>
          {(open.length > 0 || handled.length > 0) && (
            <ul className="mt-4 space-y-2 text-lg">
              {open.map((f) => (
                <li key={f.id}>
                  <strong>Waiting:</strong> {f.title}
                </li>
              ))}
              {handled.map((f) => (
                <li key={f.id}>
                  <strong>{f.owner} is checking:</strong> {f.title}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="fam-meds" className="mt-8 rounded-lg border border-line bg-surface p-6 shadow-[var(--shadow-paper)]">
          <h2 id="fam-meds" className="font-display text-2xl">
            Today’s medicines
          </h2>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["✓", "Taken", c.taken, "text-brand"],
              ["–", "Not taken", c.notTaken, "text-ink"],
              ["?", "Unconfirmed", c.unconfirmed, c.unconfirmed ? "text-attention" : "text-ink"],
              ["○", "Still to come", c.toCome, "text-ink"],
            ].map(([sym, label, n, cls]) => (
              <div key={label as string} className="rounded-md bg-oat p-4">
                <dt className="flex items-center gap-1.5 font-bold text-muted">
                  <span aria-hidden="true">{sym}</span>
                  {label}
                </dt>
                <dd className={`num mt-1 text-4xl ${cls}`}>{n}</dd>
              </div>
            ))}
          </dl>
          <ul className="mt-6 divide-y divide-line">
            {state.doses.map((d) => (
              <li key={d.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-3 py-3">
                <span className="num text-xl">{d.time}</span>
                <span className="min-w-0 text-lg">
                  {d.name} {d.strength}
                  {d.recordedBy && <span className="block text-base text-muted">Recorded: {d.recordedBy}</span>}
                </span>
                <DoseStatus d={d} />
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="fam-activity" className="mt-10">
          <h2 id="fam-activity" className="mb-4 font-display text-2xl">
            Recent activity
          </h2>
          <ol className="space-y-2 border-l-2 border-line pl-5 text-lg">
            {[...state.activity].reverse().map((e, i) => (
              <li key={i}>
                <span className="num font-bold">{e.time}</span> {e.text}
              </li>
            ))}
          </ol>
        </section>
      </div>

      <aside className="space-y-6 lg:pt-4">
        {next && (
          <section className="rounded-lg bg-oat p-5" aria-labelledby="fam-next">
            <h2 id="fam-next" className="font-display text-2xl">
              Next medicine
            </h2>
            <p className="num mt-2 text-2xl text-brand">{next.time}</p>
            <p className="font-bold">
              {next.name} {next.strength}
            </p>
          </section>
        )}
        <section className="rounded-lg bg-oat p-5" aria-labelledby="fam-appt">
          <h2 id="fam-appt" className="font-display text-2xl">
            Next appointment
          </h2>
          <p className="num mt-2 font-bold text-brand">{APPOINTMENT.when}</p>
          <p>
            {APPOINTMENT.doctor}, {APPOINTMENT.specialty}
          </p>
          <p className="text-muted">{APPOINTMENT.place}</p>
        </section>
        <section className="rounded-lg bg-oat p-5" aria-labelledby="fam-team">
          <h2 id="fam-team" className="font-display text-2xl">
            Care team
          </h2>
          <ul className="mt-2 space-y-1 text-lg">
            <li>Priya (you), family administrator</li>
            <li>Ravi, caregiver</li>
            <li>Meera, caregiver</li>
          </ul>
          <p className="mt-3 text-base text-muted">In the real app, Priya also manages medicines, appointments and who has access.</p>
        </section>
      </aside>
    </div>
  );
}
