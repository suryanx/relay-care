import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import type { DoseView, ElderTodayResponse } from "../../shared/schemas";
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

const STATUS: Record<DoseView["phase"], { text: string; symbol: string; tone: string }> = {
  upcoming: { text: "Later today", symbol: "○", tone: "border-line bg-canvas text-ink" },
  due: { text: "Due now", symbol: "●", tone: "border-amber-700 bg-amber-50 text-amber-900" },
  unconfirmed: { text: "Not confirmed yet", symbol: "?", tone: "border-amber-700 bg-amber-50 text-amber-900" },
  taken: { text: "Taken", symbol: "✓", tone: "border-brand bg-emerald-50 text-brand" },
  not_taken: { text: "Not taken", symbol: "–", tone: "border-line bg-canvas text-ink" },
  void: { text: "Removed", symbol: "×", tone: "border-line bg-canvas text-muted" },
};

const ROUTINE_STATUS: Partial<Record<DoseView["phase"], string>> = { taken: "Done", upcoming: "Later today", due: "Today" };

function StatusChip({ dose }: { dose: DoseView }) {
  const s = STATUS[dose.phase];
  const text = dose.kind === "routine" ? (ROUTINE_STATUS[dose.phase] ?? s.text) : s.text;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border-2 px-3 py-1 text-base font-bold ${s.tone}`}>
      <span aria-hidden="true">{s.symbol}</span>
      {text}
    </span>
  );
}

const BIG_BTN = "min-h-16 w-full rounded-2xl px-5 py-4 text-xl font-bold disabled:opacity-60";

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
  if (!me.isElder) return <Navigate to="/" replace />;

  const data = today.data;
  if (!data) {
    return (
      <main className="mx-auto max-w-2xl p-6 text-2xl" id="main">
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

  return (
    <div className="min-h-screen bg-canvas">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded focus:bg-surface focus:p-3">
        Skip to main content
      </a>
      <main id="main" className="mx-auto max-w-2xl px-4 pb-16 pt-10 text-lg sm:pt-14">
        <header className="mb-8 text-center">
          <p className="mb-2 text-base font-bold uppercase tracking-widest text-brand">Relay</p>
          <h1 className="text-4xl font-bold leading-tight sm:text-5xl">{greeting(data.preferredName, tz, now)}</h1>
          <p className="mt-3 text-xl text-muted">{clock}</p>
        </header>

        <div
          ref={messageRef}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          className={
            message
              ? `mb-6 rounded-2xl border-2 p-5 text-xl ${
                  message.tone === "error" ? "border-danger bg-surface text-danger" : message.tone === "ok" ? "border-brand bg-emerald-50" : "border-line bg-surface"
                }`
              : "sr-only"
          }
        >
          {message?.text}
        </div>

        {/* Next medicine */}
        <section aria-labelledby="next-heading" className="mb-8 rounded-3xl border-2 border-line bg-surface p-6 shadow-sm sm:p-8">
          {focus ? (
            <>
              <h2 id="next-heading" className="mb-1 text-lg font-bold uppercase tracking-wide text-muted">
                {focus.canRecord ? "Your medicine now" : "Your next medicine"}
              </h2>
              <p className="text-5xl font-bold text-brand">{formatTime(focus.localTime)}</p>
              <p className="mt-2 text-3xl font-bold">{focus.label}</p>
              {focus.detail && <p className="mt-2 text-xl">{focus.detail}</p>}
              <div className="mt-3">
                <StatusChip dose={focus} />
              </div>

              {focus.canRecord ? (
                <div className="mt-6 grid gap-3">
                  <button type="button" disabled={busy} onClick={() => taken(focus)} className={`${BIG_BTN} bg-brand text-brand-ink`}>
                    ✓ I have taken it
                  </button>
                  {focus.canSnooze && (
                    <button type="button" disabled={busy} onClick={() => later(focus)} className={`${BIG_BTN} border-2 border-brand bg-surface text-brand`}>
                      Remind me later
                      <span className="block text-base font-normal">in 15 minutes · {2 - focus.snoozeCount} left</span>
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => notTaken(focus)} className={`${BIG_BTN} border-2 border-line bg-surface text-ink`}>
                    I did not take it
                  </button>
                </div>
              ) : (
                <p className="mt-6 text-xl">You can confirm this from an hour before it is due.</p>
              )}
            </>
          ) : (
            <>
              <h2 id="next-heading" className="text-3xl font-bold">
                {meds.length ? "All done for today" : "No medicines today"}
              </h2>
              <p className="mt-2 text-xl text-muted">{meds.length ? "Thank you. There is nothing else to confirm right now." : "Enjoy your day."}</p>
            </>
          )}
        </section>

        {/* Help — always reachable */}
        <button
          type="button"
          disabled={busy}
          onClick={() => help(focus?.canRecord ? focus : null)}
          className={`${BIG_BTN} mb-10 border-2 border-amber-700 bg-amber-50 text-amber-900`}
        >
          I need help
          <span className="block text-base font-normal">Lets your care team know in Relay</span>
        </button>

        {/* Today's medicines */}
        <section aria-labelledby="meds-heading" className="mb-10">
          <h2 id="meds-heading" className="mb-4 text-2xl font-bold">
            Today’s medicines
          </h2>
          {meds.length === 0 ? (
            <p className="text-muted">Nothing scheduled.</p>
          ) : (
            <ul className="space-y-3">
              {meds.map((d) => (
                <li key={d.id} className="rounded-2xl border border-line bg-surface p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-2xl font-bold">{formatTime(d.localTime)}</p>
                    <StatusChip dose={d} />
                  </div>
                  <p className="mt-1 text-xl font-bold">{d.label}</p>
                  {d.detail && <p className="text-lg text-muted">{d.detail}</p>}
                  {d.phase === "unconfirmed" && <p className="mt-1">If you already took this, you can still tell us below.</p>}
                  {d.canRecord && d.id !== focus?.id && (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <button type="button" disabled={busy} onClick={() => taken(d)} className="min-h-14 rounded-xl bg-brand px-4 text-lg font-bold text-brand-ink">
                        ✓ I have taken it<span className="sr-only"> — {d.label}</span>
                      </button>
                      <button type="button" disabled={busy} onClick={() => notTaken(d)} className="min-h-14 rounded-xl border-2 border-line px-4 text-lg font-bold">
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
          <section aria-labelledby="routines-heading" className="mb-10">
            <h2 id="routines-heading" className="mb-4 text-2xl font-bold">
              Today’s routines
            </h2>
            <ul className="space-y-3">
              {routines.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4">
                  <div>
                    <p className="text-xl font-bold">{r.label}</p>
                    <p className="text-muted">{formatTime(r.localTime)}</p>
                  </div>
                  {r.status === "taken" ? (
                    <StatusChip dose={r} />
                  ) : r.canRecord ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        act(`/elder/doses/${encodeURIComponent(r.id)}/outcome`, { outcome: "taken" }, () => ({ text: `Well done — “${r.label}” is marked as done.`, tone: "ok" }))
                      }
                      className="min-h-14 rounded-xl border-2 border-brand px-5 text-lg font-bold text-brand"
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

        <section aria-labelledby="appts-heading" className="mb-10">
          <h2 id="appts-heading" className="mb-4 text-2xl font-bold">
            Upcoming appointments
          </h2>
          {data.appointments.length === 0 ? (
            <p className="text-muted">No appointments booked.</p>
          ) : (
            <ul className="space-y-3">
              {data.appointments.map((a) => (
                <li key={a.id} className="rounded-2xl border border-line bg-surface p-4">
                  <p className="text-lg font-bold text-brand">
                    {formatDate(a.localDate)} at {formatTime(a.localTime)}
                  </p>
                  <p className="text-xl font-bold">
                    {a.doctorName}
                    {a.specialty ? ` — ${a.specialty}` : ""}
                  </p>
                  {a.location && <p className="text-muted">{a.location}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="text-center text-base text-muted">Relay helps your family stay in touch. It does not replace your doctor or emergency services.</p>
        <p className="mt-6 text-center">
          <button type="button" onClick={signOut} className="min-h-11 text-base text-muted underline">
            Sign out of this device
          </button>
        </p>
      </main>
    </div>
  );
}
