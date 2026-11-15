import { useEffect, useId, useRef, type InputHTMLAttributes, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { authClient } from "../lib/auth-client";
import { useSession } from "../lib/session";

export function Shell({
  title,
  children,
  wide = false,
  nav,
  eyebrow,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
  nav?: ReactNode;
  eyebrow?: string;
}) {
  const { me, refresh } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    document.title = `${title} · Relay`;
  }, [title]);

  async function signOut() {
    await authClient.signOut();
    await refresh();
    navigate("/sign-in");
  }

  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded focus:bg-surface focus:p-3">
        Skip to main content
      </a>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <Link to="/" className="text-xl font-bold text-brand no-underline">
            Relay
          </Link>
          {me && (
            <div className="flex items-center gap-3 text-sm">
              <span className="hidden text-muted sm:inline">Signed in as {me.user.name}</span>
              <button type="button" onClick={signOut} className="rounded-lg border border-line px-3 py-2 hover:bg-canvas">
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main id="main" className={`mx-auto px-4 py-8 ${wide ? "max-w-4xl" : "max-w-xl"}`}>
        {eyebrow && <p className="mb-1 font-bold text-muted">{eyebrow}</p>}
        <h1 className="mb-6 text-3xl font-bold leading-tight">{title}</h1>
        {nav}
        {children}
      </main>
    </>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function Field({ label, hint, error, ...input }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className="mb-5">
      <label htmlFor={id} className="mb-1 block font-bold">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="mb-2 text-sm text-muted">
          {hint}
        </p>
      )}
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errId].filter(Boolean).join(" ") || undefined}
        className="w-full rounded-lg border-2 border-line bg-surface px-3 py-3 text-base aria-[invalid]:border-danger"
        {...input}
      />
      {error && (
        <p id={errId} className="mt-1 text-sm font-bold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function PrimaryButton({ children, busy, ...rest }: { children: ReactNode; busy?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      disabled={busy || rest.disabled}
      aria-busy={busy || undefined}
      className="min-h-12 w-full rounded-lg bg-brand px-5 py-3 text-lg font-bold text-brand-ink hover:opacity-90 disabled:opacity-60 sm:w-auto"
    >
      {busy ? "Please wait…" : children}
    </button>
  );
}

/** Announces form-level errors and moves focus to them. */
export function FormError({ message }: { message: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  if (!message) return null;
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="mb-5 rounded-lg border-2 border-danger bg-surface p-4 font-bold text-danger">
      {message}
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <section className="mb-6 rounded-xl border border-line bg-surface p-5 shadow-sm">{children}</section>;
}

export function LinkButton({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex min-h-12 items-center rounded-lg bg-brand px-5 py-3 font-bold text-brand-ink no-underline hover:opacity-90">
      {children}
    </Link>
  );
}

export function SecondaryButton({ children, ...rest }: { children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`min-h-11 rounded-lg border-2 border-line bg-surface px-4 py-2 font-bold hover:bg-canvas disabled:opacity-60 ${rest.className ?? ""}`}
    >
      {children}
    </button>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border-2 border-dashed border-line bg-surface p-6 text-center text-muted">{children}</p>;
}

export function TextArea({ label, hint, error, ...rest }: { label: string; hint?: string; error?: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="mb-5">
      <label htmlFor={id} className="mb-1 block font-bold">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="mb-2 text-sm text-muted">
          {hint}
        </p>
      )}
      <textarea
        id={id}
        rows={3}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className="w-full rounded-lg border-2 border-line bg-surface px-3 py-3 aria-[invalid]:border-danger"
        {...rest}
      />
      {error && (
        <p id={`${id}-err`} className="mt-1 text-sm font-bold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
