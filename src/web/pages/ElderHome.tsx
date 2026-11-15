import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import type { DoseView, ElderTodayResponse } from "../../shared/schemas";
import { Logo, Pill, buttonClass, type Tone } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { formatDate, formatTime } from "../lib/format";
import { useSession } from "../lib/session";
import { useApi } from "../lib/useApi";

/** Greeting by the elder's local hour. Warm, adult, not childish. */
export function greeting(name: string, timeZone: string, now: Date): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  if (hour >= 5 && hour < 12) return `Good morning, ${name}`;
  if (hour >= 12 && hour < 17) return `Good afternoon, ${name}`;
  if (hour >= 17 && hour < 21) return `Good evening, ${name}`;
  return `Good night, ${name}`;
}

const STATUS: Record<DoseView["phase"], { text: string; symbol: string; tone: Tone }> = {
  upcoming: { text: "Later today", symbol: "○", tone: "neutral" },
  due: { text: "Due now", symbol: "●", tone: "brand" },
  unconfirmed: { text: "Not confirmed yet", symbol: "?", tone: "attention" },
  taken: { text: "Taken", symbol: "✓", tone: "good" },
  not_taken: { text: "Not taken", symbol: "–", tone: "neutral" },
  void: { text: "Removed", symbol: "×", tone: "neutral" },
};

const ROUTINE_STATUS: Partial<Record<DoseView["phase"], string>> = { taken: "Done", upcoming: "Later today", due: "Today" };

function StatusChip({ dose }: { dose: DoseView }) {
  const s = STATUS[dose.phase];
  return (
    <Pill tone={s.tone} symbol={s.symbol}>
      {dose.kind === "routine" ? (ROUTINE_STATUS[dose.phase] ?? s.text) : s.text}
    </Pill>
  );
}


export default function ElderHome() {
  const { me, refresh: refreshSession } = useSession();
  const navigate = useNavigate();
  const today = useApi<ElderTodayResponse>(me?.isElder ? "/elder/today" : null);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "info" | "error" } | null>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const reload = today.reload;

  // Keep the clock and the dose phases current.
  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), 30_000);
    const data = setInterval(reload, 60_000);
    return () => {
      clearInterval(clock);
      clearInterval(data);
    };
  }, [reload]);

  useEffect(() => {
    if (message) messageRef.current?.focus();
  }, [message]);

  const titleName = today.data?.preferredName;
  const titleZone = today.data?.timezone;
  const titleGreeting = titleName && titleZone ? greeting(titleName, titleZone, now) : null;
  useEffect(() => {
    document.title = titleGreeting ? `${titleGreeting} · Relay` : "Relay";
  }, [titleGreeting]);

  if (!me) return <Navigate to="/sign-in" replace />;
  if (!me.isElder) return <Navigate to="/home" replace />;

  const data = today.data;
  if (!data) {
    return (
      <main className="grid min-h-dvh place-items-center p-6 text-2xl text-muted" id="main">
        <p role="status">{today.error ?? "Loading your day…"}</p>
      </main>
    );
  }

  const meds = data.doses.filter((d) => d.kind === "medication");
  const routines = data.doses.filter((d) => d.kind === "routine");
  const focus = meds.find((d) => d.canRecord) ?? meds.find((d) => d.phase === "upcoming") ?? null;
  const tz = data.timezone;
  const clock = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: tz }).format(now);
  const timeIn = (iso: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(iso));

  async function act(path: string, body: object, success: (res: Record<string, unknown>) => { text: string; tone: "ok" | "info" }) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api<Record<string, unknown>>(path, { method: "POST", body: JSON.stringify(body) });
      setMessage(success(res));
      reload();
    } catch (err) {
      setMessage({
        text: err instanceof ApiError ? err.body.message : "Something went wrong. Please try again, or ask your family for help.",
        tone: "error",
      });
      reload();
    } finally {
      setBusy(false);
    }
  }

  const taken = (d: DoseView) =>
    act(`/elder/doses/${encodeURIComponent(d.id)}/outcome`, { outcome: "taken" }, () => ({
      text: `Thank you. ${d.label} is recorded as taken at ${timeIn(new Date().toISOString())}.`,
      tone: "ok",
    }));
  const notTaken = (d: DoseView) =>
    act(`/elder/doses/${encodeURIComponent(d.id)}/outcome`, { outcome: "not_taken" }, () => ({
      text: "Thank you for letting us know. This is recorded and your care team can see it in Relay. If you are unsure what to do, please ask your pharmacist or doctor.",
      tone: "info",
    }));
  const later = (d: DoseView) =>
    act(`/elder/doses/${encodeURIComponent(d.id)}/snooze`, {}, (res) => ({
      text: `Okay. We will show this again after ${timeIn(String(res.snoozeUntil))}. Your medicine time has not changed.${
        Number(res.remaining) === 0 ? " This was the last “remind me later” for this dose." : ""
      }`,
      tone: "info",
    }));
  const help = (d: DoseView | null) =>
    act("/elder/help", { doseId: d?.id ?? null }, () => ({
      text: "Your request for help has been saved. Your care team will see it when they open Relay. If this is an emergency, call your local emergency number now.",
      tone: "info",
    }));

  async function signOut() {
    await authClient.signOut();
    await refreshSession();
    navigate("/sign-in");
  }

  const BIG = (variant: "primary" | "secondary") => buttonClass(variant, "lg", "min-h-16 w-full text-2xl");

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:p-3 focus:font-bold">
        Skip to main content
      </a>
      <header className="w-full border-b border-line">
        <div className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between px-4">
          <Logo to="/elder" />
          <p className="num hidden text-lg text-muted sm:block">{clock}</p>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 pb-16 pt-10 text-xl sm:pt-14">
        <h1 className="font-display text-5xl font-medium leading-tight sm:text-6xl">{greeting(data.preferredName, tz, now)}</h1>
        <p className="num mt-3 whitespace-normal text-2xl text-muted sm:hidden">{clock}</p>
        <p className="mt-2 text-2xl text-muted">{data.doses.length ? "Here is your day." : "Nothing is planned for today."}</p>

        <div
          ref={messageRef}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          className={
            message
              ? `mt-8 rounded-lg border-l-4 p-5 text-xl ${
                  message.tone === "error" ? "border-danger bg-danger-soft text-danger" : message.tone === "ok" ? "border-brand bg-brand-soft" : "border-line-strong bg-oat"
                }`
              : "sr-only"
          }
        >
          {message?.text}
        </div>

        {/* The one thing to do now */}
        <section aria-labelledby="next-heading" className="mt-8 rounded-lg border border-line bg-surface p-6 shadow-[var(--shadow-paper)] sm:p-8">
          {focus ? (
            <>
              <h2 id="next-heading" className="text-xl font-bold text-muted">
                {focus.canRecord ? "Your medicine now" : "Your next medicine"}
              </h2>
              <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
                <p className="num text-6xl text-brand">{formatTime(focus.localTime)}</p>
                <StatusChip dose={focus} />
              </div>
              <p className="mt-3 font-display text-4xl leading-tight">{focus.label}</p>
              {focus.detail && <p className="mt-2 text-2xl">{focus.detail}</p>}

              {focus.canRecord ? (
                <div className="mt-8 grid gap-3">
                  <button type="button" disabled={busy} onClick={() => taken(focus)} className={BIG("primary")}>
                    <span aria-hidden="true">✓</span> I have taken it
                  </button>
                  {focus.canSnooze && (
                    <button type="button" disabled={busy} onClick={() => later(focus)} className={`${BIG("secondary")} flex-col gap-0 py-3`}>
                      Remind me later
                      <span className="text-lg font-normal text-muted">
                        in 15 minutes, <span className="num">{2 - focus.snoozeCount}</span> left
                      </span>
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => notTaken(focus)} className={BIG("secondary")}>
                    I did not take it
                  </button>
                </div>
              ) : (
                <p className="mt-6 text-xl text-muted">You can confirm this from an hour before it is due.</p>
              )}
            </>
          ) : (
            <>
              <h2 id="next-heading" className="font-display text-4xl">
                {meds.length ? "All done for today" : "No medicines today"}
              </h2>
              <p className="mt-2 text-2xl text-muted">{meds.length ? "Thank you. There is nothing else to confirm right now." : "Enjoy your day."}</p>
            </>
          )}
        </section>

        {data.helpRequests[0] && <HelpStatus help={data.helpRequests[0]} />}

        {/* Help — always reachable */}
        <button
          type="button"
          disabled={busy}
          onClick={() => help(focus?.canRecord ? focus : null)}
          className="mt-6 flex min-h-16 w-full flex-col items-center justify-center rounded-md border-2 border-attention bg-attention-soft px-5 py-3 text-2xl font-bold text-attention hover:bg-[#f2dccf] disabled:opacity-60"
        >
          I need help
          <span className="text-lg font-normal">Lets your care team know in Relay</span>
        </button>

        {/* Today's medicines */}
        <section aria-labelledby="meds-heading" className="mt-14">
          <h2 id="meds-heading" className="mb-5 font-display text-3xl">
            Today’s medicines
          </h2>
          {meds.length === 0 ? (
            <p className="text-muted">Nothing scheduled.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {meds.map((d) => (
                <li key={d.id} className="p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="num text-3xl">{formatTime(d.localTime)}</p>
                    <StatusChip dose={d} />
                  </div>
                  <p className="mt-1 text-2xl font-bold">{d.label}</p>
                  {d.detail && <p className="text-xl text-muted">{d.detail}</p>}
                  {d.phase === "unconfirmed" && <p className="mt-2 text-xl">If you already took this, you can still tell us.</p>}
                  {d.canRecord && d.id !== focus?.id && (
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <button type="button" disabled={busy} onClick={() => taken(d)} className={buttonClass("primary", "lg")}>
                        ✓ I have taken it<span className="sr-only"> — {d.label}</span>
                      </button>
                      <button type="button" disabled={busy} onClick={() => notTaken(d)} className={buttonClass("secondary", "lg")}>
                        I did not take it<span className="sr-only"> — {d.label}</span>
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {routines.length > 0 && (
          <section aria-labelledby="routines-heading" className="mt-14">
            <h2 id="routines-heading" className="mb-5 font-display text-3xl">
              Today’s routines
            </h2>
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {routines.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-5">
                  <div>
                    <p className="text-2xl font-bold">{r.label}</p>
                    <p className="num text-xl text-muted">{formatTime(r.localTime)}</p>
                  </div>
                  {r.status === "taken" ? (
                    <StatusChip dose={r} />
                  ) : r.canRecord ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        act(`/elder/doses/${encodeURIComponent(r.id)}/outcome`, { outcome: "taken" }, () => ({ text: `Well done. “${r.label}” is marked as done.`, tone: "ok" }))
                      }
                      className={buttonClass("secondary", "lg")}
                    >
                      Mark as done<span className="sr-only"> — {r.label}</span>
                    </button>
                  ) : (
                    <StatusChip dose={r} />
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="appts-heading" className="mt-14">
          <h2 id="appts-heading" className="mb-5 font-display text-3xl">
            Upcoming appointments
          </h2>
          {data.appointments.length === 0 ? (
            <p className="text-muted">No appointments booked.</p>
          ) : (
            <ul className="space-y-3">
              {data.appointments.map((a) => (
                <li key={a.id} className="rounded-lg bg-oat p-5">
                  <p className="num text-xl font-bold text-brand">
                    {formatDate(a.localDate)}, {formatTime(a.localTime)}
                  </p>
                  <p className="mt-1 text-2xl font-bold">
                    {a.doctorName}
                    {a.specialty ? `, ${a.specialty}` : ""}
                  </p>
                  {a.location && <p className="text-xl text-muted">{a.location}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="mt-14 text-center text-lg text-muted">Relay helps your family stay in touch. It does not replace your doctor or emergency services.</p>
        <p className="mt-4 text-center">
          <button type="button" onClick={signOut} className="min-h-11 text-lg text-muted underline">
            Sign out of this device
          </button>
        </p>
      </main>
    </div>
  );
}

function HelpStatus({ help }: { help: ElderTodayResponse["helpRequests"][number] }) {
  const text =
    help.status === "open"
      ? "Your request for help is waiting for someone in your care team to pick it up."
      : help.status === "acknowledged"
        ? `${help.handledBy ?? "Someone in your care team"} is looking into your request.`
        : "Your care team marked your request for help as sorted out.";
  return (
    <section aria-labelledby="help-status-heading" className="mt-6 rounded-lg border-l-4 border-brand bg-brand-soft p-5">
      <h2 id="help-status-heading" className="font-display text-2xl">
        Your request for help
      </h2>
      <p className="mt-1 text-xl">{text}</p>
      <p className="mt-2 text-lg text-muted">Relay is not an emergency service. In an emergency, call your local emergency number.</p>
    </section>
  );
}
