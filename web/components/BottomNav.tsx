"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/intake", label: "Intake", icon: UploadIcon },
  { href: "/events", label: "Events", icon: ListIcon },
  { href: "/advisor", label: "Advisor", icon: CompassIcon },
  { href: "/visions", label: "Visions", icon: SeedIcon },
  { href: "/journal", label: "Journal", icon: JournalIcon },
] as const;

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed bottom-0 z-50 flex h-14 w-full overflow-x-auto border-t border-[#2A2A28] bg-[#161614]"
      style={{ borderTopWidth: "0.5px" }}
    >
      {ITEMS.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-w-[4.25rem] flex-1 flex-col items-center justify-center gap-1 ${
              active ? "text-[#7F77DD]" : "text-[#6B6963]"
            }`}
          >
            <Icon prominent={item.href === "/advisor"} />
            <span className="text-[9px] leading-none">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function UploadIcon({ prominent }: { prominent?: boolean }) {
  void prominent;
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 16V5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 8.5 12 4.5l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 16.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ListIcon({ prominent }: { prominent?: boolean }) {
  void prominent;
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 7h11M9 12h11M9 17h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.5 7h.01M4.5 12h.01M4.5 17h.01" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function CompassIcon({ prominent = false }: { prominent?: boolean }) {
  const size = prominent ? 22 : 18;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5" />
      <path d="m14.8 9.2-1.6 4.2-4.2 1.6 1.6-4.2 4.2-1.6Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function SeedIcon({ prominent }: { prominent?: boolean }) {
  void prominent;
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 20V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M12 13c2.8-1.2 4.2-3.4 4.5-6.2-3 .2-5 1.6-6 3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M12 14.5c-2.2-1-3.6-2.8-4.2-5.2 2.6.4 4.2 1.6 5.2 3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function JournalIcon({ prominent }: { prominent?: boolean }) {
  void prominent;
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6.5 3.5h11A1.5 1.5 0 0 1 19 5v14.5H7.2A2.2 2.2 0 0 0 5 21.7V5.7A2.2 2.2 0 0 1 7.2 3.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8.5 8h6.5M8.5 11.5h6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

