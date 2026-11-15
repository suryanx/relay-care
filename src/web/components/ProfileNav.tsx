import { useEffect, useRef } from "react";
import { Link, NavLink, useLocation } from "react-router";

const tabs: { to: string; label: string; end?: boolean; adminOnly?: boolean }[] = [
  { to: "", label: "Today", end: true },
  { to: "follow-ups", label: "Follow-ups" },
  { to: "schedule", label: "Schedule" },
  { to: "medications", label: "Medicines" },
  { to: "routines", label: "Routines" },
  { to: "appointments", label: "Appointments" },
  { to: "team", label: "Care team", adminOnly: true },
  { to: "notifications", label: "Notifications", adminOnly: true },
];

/**
 * Navigation for one care profile: a quiet vertical list on large screens, a scrollable tab row on small
 * ones. Admin-only items are hidden for caregivers (the server enforces access regardless).
 */
export function ProfileNav({ profileId, name, role }: { profileId: string; name?: string; role?: "admin" | "caregiver" | "elder" }) {
  const navRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();

  // On narrow screens the tab row scrolls; keep the current item visible.
  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <nav ref={navRef} aria-label={name ? `${name}'s care` : "Care profile sections"} className="mb-6 lg:mb-0">
      {name && (
        <div className="mb-4 hidden items-center gap-3 lg:flex">
          <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-full bg-brand font-display text-xl text-brand-ink">
            {name.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <p className="truncate font-display text-xl leading-tight">{name}</p>
            <p className="text-sm text-muted">{role === "admin" ? "You are the family administrator" : "You are a caregiver"}</p>
          </div>
        </div>
      )}
      <ul className="flex gap-1 overflow-x-auto border-b border-line pb-px lg:flex-col lg:overflow-visible lg:border-b-0 lg:pb-0">
        {tabs
          .filter((t) => !t.adminOnly || role === undefined || role === "admin")
          .map((t) => (
            <li key={t.label} className="shrink-0">
              <NavLink
                to={`/profiles/${profileId}${t.to ? `/${t.to}` : ""}`}
                end={t.end}
                className={({ isActive }) =>
                  `flex min-h-11 items-center whitespace-nowrap px-3 font-bold no-underline lg:rounded-md lg:px-4 ${
                    isActive
                      ? "border-b-[3px] border-brand text-brand lg:border-b-0 lg:bg-brand lg:text-brand-ink"
                      : "border-b-[3px] border-transparent text-muted hover:text-ink lg:border-b-0 lg:hover:bg-oat"
                  }`
                }
              >
                {t.label}
              </NavLink>
            </li>
          ))}
      </ul>
      <p className="mt-6 hidden lg:block">
        <Link to="/home" className="text-base font-bold text-brand underline-offset-4 hover:underline">
          All care profiles
        </Link>
      </p>
    </nav>
  );
}
