"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getGraphSuggestions } from "@/lib/api";

const ITEMS = [
  { href: "/home", label: "Home", icon: HouseIcon },
  { href: "/library", label: "Library", icon: GridIcon },
  { href: "/account", label: "Account", icon: PersonIcon },
] as const;

export default function BottomNav() {
  const pathname = usePathname();
  const [reviewCount, setReviewCount] = useState(0);
  useEffect(() => {
    if (pathname === "/login") return;
    getGraphSuggestions()
      .then((page) => setReviewCount(page.count || 0))
      .catch(() => setReviewCount(0));
  }, [pathname]);
  if (pathname === "/login") return null;

  return (
    <nav
      className="fixed bottom-0 z-50 flex h-14 w-full border-t border-[#2A2A28] bg-[#161614]"
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
            className={`flex flex-1 flex-col items-center justify-center gap-1 ${active ? "text-[#7F77DD]" : "text-[#6B6963]"}`}
          >
            <span className="relative">
              <Icon />
              {item.href === "/library" && reviewCount > 0 ? (
                <span className="absolute -right-2 -top-1 h-1.5 w-1.5 rounded-full bg-[#7F77DD]" />
              ) : null}
            </span>
            <span className="text-[9px] leading-none">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function HouseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 11.5 12 4l8 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 10.5V20h10v-9.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="6.5" height="6.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 19.5c1.2-2.8 3.3-4 6.5-4s5.3 1.2 6.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
