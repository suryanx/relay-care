import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Link, useNavigate } from "react-router";
import { authClient } from "../lib/auth-client";
import { useSession } from "../lib/session";

/* ------------------------------------------------------------------ */
/* Brand                                                               */
/* ------------------------------------------------------------------ */

/** The Relay mark: two points joined by a hand-off curve. */
export function Logo({ to = "/", className = "" }: { to?: string; className?: string }) {
  return (
    <Link to={to} className={`inline-flex items-center gap-2 text-brand no-underline ${className}`} aria-label="Relay home">
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M6 22 C 12 6, 20 26, 26 10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="6" cy="22" r="3.5" fill="var(--color-terracotta)" />
        <circle cx="26" cy="10" r="3.5" fill="currentColor" />
      </svg>
      <span className="font-display text-2xl font-semibold tracking-tight">Relay</span>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* App shell                                                           */
/* ------------------------------------------------------------------ */

export function AppHeader() {
  const { me, refresh } = useSession();
  const navigate = useNavigate();
  async function signOut() {
    await authClient.signOut();
    await refresh();
    navigate("/sign-in");
  }
  return (
    <header className="sticky top-0 z-20 w-full border-b border-line bg-canvas/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <Logo to={me ? (me.isElder ? "/elder" : "/home") : "/"} />
        {me ? (
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted sm:inline">
              Signed in as <span className="font-bold text-ink">{me.user.name}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={signOut}>
              Sign out
            </Button>
          </div>
        ) : (
          <Link to="/sign-in" className="font-bold text-brand underline-offset-4 hover:underline">
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}

const skipLink =
  "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:p-3 focus:font-bold focus:shadow";

/**
 * Page frame for signed-in screens. With `nav`, a sidebar appears on large screens and
 * becomes a tab row above the content on small ones. Content width stays readable on wide monitors.
 */
export function Shell({
  title,
  children,
  wide = false,
  nav,
  eyebrow,
  actions,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
  nav?: ReactNode;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} · Relay`;
  }, [title]);

  const heading = (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-base font-bold text-muted">{eyebrow}</p>}
        <h1 className="font-display text-4xl font-medium leading-tight text-ink sm:text-[2.6rem]">{title}</h1>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );

  return (
    <>
      <a href="#main" className={skipLink}>
        Skip to main content
      </a>
      <AppHeader />
      {nav ? (
        <div className="mx-auto grid w-full max-w-7xl flex-1 gap-x-10 px-4 pb-16 pt-6 sm:px-6 lg:grid-cols-[14.5rem_minmax(0,1fr)] lg:pt-10">
          <aside className="min-w-0 lg:sticky lg:top-24 lg:self-start">{nav}</aside>
          <main id="main" className="min-w-0 max-w-4xl">
            {heading}
            {children}
          </main>
        </div>
      ) : (
        <main id="main" className={`mx-auto w-full flex-1 px-4 pb-16 pt-10 sm:px-6 ${wide ? "max-w-5xl" : "max-w-xl"}`}>
          {heading}
          {children}
        </main>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

type Variant = "primary" | "secondary" | "danger" | "quiet";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-brand text-brand-ink hover:bg-brand-hover border-2 border-brand",
  secondary: "bg-surface text-brand border-2 border-line-strong hover:border-brand",
  danger: "bg-surface text-danger border-2 border-danger hover:bg-danger-soft",
  quiet: "bg-transparent text-brand border-2 border-transparent underline underline-offset-4 hover:bg-brand-soft",
};
const SIZE: Record<Size, string> = {
  sm: "min-h-11 px-4 text-base",
  md: "min-h-12 px-5 text-lg",
  lg: "min-h-14 px-6 text-xl",
};

export function buttonClass(variant: Variant = "primary", size: Size = "md", extra = "") {
  return `inline-flex items-center justify-center gap-2 rounded-md font-bold no-underline transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${VARIANT[variant]} ${SIZE[size]} ${extra}`;
}

export function Button({
  variant = "primary",
  size = "md",
  busy,
  className = "",
  children,
  ...rest
}: { variant?: Variant; size?: Size; busy?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} disabled={busy || rest.disabled} aria-busy={busy || undefined} className={buttonClass(variant, size, className)}>
      {busy ? "Please wait…" : children}
    </button>
  );
}

/** Primary submit/action button (kept for existing call sites). */
export function PrimaryButton({ children, busy, ...rest }: { children: ReactNode; busy?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button variant="primary" busy={busy} {...rest} className={`w-full sm:w-auto ${rest.className ?? ""}`}>
      {children}
    </Button>
  );
}

export function SecondaryButton({ children, className = "", ...rest }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button variant="secondary" size="sm" {...rest} className={className}>
      {children}
    </Button>
  );
}

export function DangerButton({ children, className = "", ...rest }: { children: ReactNode; busy?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button variant="danger" size="sm" {...rest} className={className}>
      {children}
    </Button>
  );
}

export function LinkButton({ to, children, variant = "primary", size = "md" }: { to: string; children: ReactNode; variant?: Variant; size?: Size }) {
  return (
    <Link to={to} className={buttonClass(variant, size)}>
      {children}
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Surfaces and feedback                                               */
/* ------------------------------------------------------------------ */

export function Card({ children, tone = "paper", className = "" }: { children: ReactNode; tone?: "paper" | "oat" | "brand"; className?: string }) {
  const tones = {
    paper: "bg-surface border border-line shadow-[var(--shadow-paper)]",
    oat: "bg-oat",
    brand: "bg-brand text-brand-ink",
  };
  return <section className={`mb-6 rounded-lg p-5 sm:p-6 ${tones[tone]} ${className}`}>{children}</section>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-oat px-5 py-6 text-center text-muted">{children}</p>;
}

/** Announces form-level errors and moves focus to them. */
export function FormError({ message }: { message: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  if (!message) return null;
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="mb-5 flex gap-3 rounded-md border-l-4 border-danger bg-danger-soft p-4 font-bold text-danger">
      <span aria-hidden="true">!</span>
      <span>{message}</span>
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="flex items-center gap-3 py-6 text-muted">
      <span aria-hidden="true" className="inline-block size-3 animate-pulse rounded-full bg-brand" />
      {label}
    </p>
  );
}

/** Status shown with a symbol AND words, never colour alone. */
export type Tone = "neutral" | "good" | "attention" | "danger" | "brand";
const PILL: Record<Tone, string> = {
  neutral: "bg-oat text-ink border-line-strong",
  good: "bg-brand-soft text-brand border-brand/30",
  attention: "bg-attention-soft text-attention border-attention/40",
  danger: "bg-danger-soft text-danger border-danger/40",
  brand: "bg-brand text-brand-ink border-brand",
};
export function Pill({ tone = "neutral", symbol, children, size = "md" }: { tone?: Tone; symbol?: string; children: ReactNode; size?: "sm" | "md" }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border font-bold ${PILL[tone]} ${size === "sm" ? "px-2.5 py-0.5 text-sm" : "px-3 py-1 text-base"}`}
    >
      {symbol && <span aria-hidden="true">{symbol}</span>}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Form fields                                                         */
/* ------------------------------------------------------------------ */

const inputClass =
  "w-full rounded-md border-2 border-line-strong bg-surface px-4 py-3 text-lg text-ink placeholder:text-muted focus:border-brand aria-[invalid]:border-danger read-only:bg-oat";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function Field({ label, hint, error, className = "", ...input }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className={`mb-5 ${className}`}>
      <label htmlFor={id} className="mb-1.5 block font-bold">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="mb-2 text-base text-muted">
          {hint}
        </p>
      )}
      <input id={id} aria-invalid={error ? true : undefined} aria-describedby={[hintId, errId].filter(Boolean).join(" ") || undefined} className={inputClass} {...input} />
      {error && (
        <p id={errId} className="mt-1.5 font-bold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextArea({ label, hint, error, ...rest }: { label: string; hint?: string; error?: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="mb-5">
      <label htmlFor={id} className="mb-1.5 block font-bold">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="mb-2 text-base text-muted">
          {hint}
        </p>
      )}
      <textarea id={id} rows={3} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className={inputClass} {...rest} />
      {error && (
        <p id={`${id}-err`} className="mt-1.5 font-bold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Large, selectable option cards for a radio choice (used in follow-up outcomes). */
export function OptionGroup({
  legend,
  name,
  value,
  onChange,
  options,
}: {
  legend: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
}) {
  return (
    <fieldset>
      <legend className="mb-2 font-bold">{legend}</legend>
      <div className="grid gap-2">
        {options.map((o) => (
          <label
            key={o.id}
            className="flex min-h-12 cursor-pointer items-center gap-3 rounded-md border-2 border-line-strong bg-surface px-4 has-[:checked]:border-brand has-[:checked]:bg-brand-soft"
          >
            <input type="radio" name={name} value={o.id} checked={value === o.id} onChange={() => onChange(o.id)} className="size-5 shrink-0 accent-[var(--color-brand)]" />
            <span className="text-lg">{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}


export { inputClass };
