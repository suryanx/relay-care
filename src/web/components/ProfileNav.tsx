import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router";

const tabs: { to: string; label: string; end?: boolean; adminOnly?: boolean }[] = [
  { to: "", label: "Overview", end: true },
  { to: "follow-ups", label: "Follow-ups" },
  { to: "schedule", label: "Schedule" },
  { to: "medications", label: "Medicines" },
  { to: "routines", label: "Routines" },
  { to: "appointments", label: "Appointments" },
  { to: "team", label: "Care team", adminOnly: true },
  { to: "notifications", label: "Notifications", adminOnly: true },
];

/** Profile-specific navigation shown on every care-team page for one elderly person. */
/** Tabs for one care profile. Admin-only tabs are hidden for caregivers (the server enforces access regardless). */
export function ProfileNav({ profileId, name, role }: { profileId: string; name?: string; role?: "admin" | "caregiver" | "elder" }) {
  const navRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();

  // On narrow screens the tab strip scrolls; keep the current tab visible.
  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <nav ref={navRef} aria-label={name ? `${name}'s care` : "Profile sections"} className="mb-6 -mx-4 overflow-x-auto px-4">
      <ul className="flex min-w-max gap-1 border-b border-line">
        {tabs
          .filter((t) => !t.adminOnly || role === undefined || role === "admin")
          .map((t) => (
          <li key={t.label}>
            <NavLink
              to={`/profiles/${profileId}${t.to ? `/${t.to}` : ""}`}
              end={t.end}
              className={({ isActive }) =>
                `-mb-px inline-block min-h-12 border-b-4 px-4 py-3 font-bold no-underline ${
                  isActive ? "border-brand text-brand" : "border-transparent text-muted hover:text-ink"
                }`
              }
            >
              {t.label}
            </NavLink>
          </li>
          ))}
      </ul>
    </nav>
  );
}
