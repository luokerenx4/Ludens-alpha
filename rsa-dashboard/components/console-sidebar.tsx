"use client";

import { useId, useRef, useState } from "react";
import { MenuIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale, useTranslations } from "@/lib/locale";
import { isPlainNavigationClick } from "@/lib/dashboard-navigation";
import type { Project } from "@/lib/types";
import { PetFollowCard, type PetFollow } from "@/components/pet-follow";

export const consoleViewIds = ["live", "replay", "benchmark", "caps", "perception", "workspaces", "docs", "settings", "dev"] as const;
export type ConsoleView = typeof consoleViewIds[number];
const navSections: Array<{ label: string; ids: ConsoleView[] }> = [
  { label: "navSectionWorkspace", ids: ["live", "replay", "benchmark", "caps", "perception"] },
  { label: "navSectionGlobal", ids: ["workspaces", "docs"] },
  { label: "navSectionDev", ids: ["dev"] },
];

function NavIcon({ kind }: { kind: ConsoleView | "logo" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {kind === "logo" ? (
        <>
          <path d="m12 2 9 5v10l-9 5-9-5V7Z" />
          <path d="m3 7 9 5 9-5M12 12v10" />
        </>
      ) : kind === "live" ? (
        <path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none" />
      ) : kind === "replay" ? (
        <><path d="M3 10a9 9 0 1 1 1 7M3 4v6h6" /><path d="m10 8 6 4-6 4Z" /></>
      ) : kind === "workspaces" ? (
        <><path d="M3 7h7l2-3h9v16H3Z" /><path d="M8 13h8M12 9v8" /></>
      ) : kind === "docs" ? (
        <>
          <path d="M5 3h11l3 3v15H5Z" /><path d="M9 9h7M9 13h7M9 17h4" />
        </>
      ) : kind === "caps" ? (
        <>
          <path d="M9 3H5v18h14V3h-4" /><path d="M9 3h6v4H9Z" /><path d="m9 16 2 2 4-4" />
        </>
      ) : kind === "perception" ? (
        <>
          <circle cx="12" cy="12" r="3.4" /><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
        </>
      ) : kind === "benchmark" ? (
        <>
          <path d="M4 19V11M10 19V5M16 19V8M22 19V2" strokeWidth="3" />
        </>
      ) : kind === "dev" ? (
        <>
          <path d="m4 17 5-5-5-5" /><path d="M12 19h8" />
        </>
      ) : (
        <>
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
        </>
      )}
    </svg>
  );
}


export function ConsoleSidebar({ view, viewLink, onNavigate, pet, petProject, onPetSettings }: {
  view: ConsoleView;
  viewLink(view: ConsoleView): string;
  onNavigate(url: string): void;
  pet: PetFollow;
  petProject?: Project;
  onPetSettings(): void;
}) {
  const { t } = useLocale();
  const dt = useTranslations("dashboard");
  const st = useTranslations("consoleSidebar");
  const id = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const closeMenu = () => {
    if (!expanded) return;
    setExpanded(false);
    menuButton.current?.focus();
  };
  const renderLink = (id: ConsoleView) => <a key={id} href={viewLink(id)}
    className={view === id ? "active" : undefined} aria-current={view === id ? "page" : undefined}
    onClick={event => {
      if (!isPlainNavigationClick(event)) return;
      event.preventDefault(); closeMenu(); onNavigate(viewLink(id));
    }}>
    <NavIcon kind={id} /><span>{t(`nav.${id}`)}</span>
  </a>;
  return <aside className="sidebar" data-expanded={expanded}>
    <a className="brand" href={viewLink("live")} onClick={event => {
      if (!isPlainNavigationClick(event)) return;
      event.preventDefault(); closeMenu(); onNavigate(viewLink("live"));
    }}><NavIcon kind="logo" /><span>Ludens</span></a>
    <Button ref={menuButton} type="button" variant="ghost" size="sm" className="sidebar-menu-toggle hidden max-[680px]:inline-flex"
      aria-expanded={expanded} aria-controls={`${id}-navigation ${id}-footer`}
      onClick={() => setExpanded(value => !value)}>
      {expanded ? <XIcon aria-hidden="true" /> : <MenuIcon aria-hidden="true" />}
      {st(expanded ? "menuClose" : "menuOpen")}
    </Button>
    <nav id={`${id}-navigation`} className="sidebar-navigation" aria-label={dt("consoleNav")}>
      {navSections.map(section => <div key={section.label} className="nav-section">
        <small>{t(section.label)}</small>{section.ids.map(renderLink)}
      </div>)}
    </nav>
    <footer id={`${id}-footer`} className="sidebar-footer">
      <PetFollowCard follow={pet} project={petProject} onSettings={() => { closeMenu(); onPetSettings(); }} />
      <nav className="sidebar-settings" aria-label={t("nav.settings")}>{renderLink("settings")}</nav>
    </footer>
  </aside>;
}
