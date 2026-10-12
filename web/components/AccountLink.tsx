"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function AccountLink() {
  const pathname = usePathname();
  if (pathname === "/login") return null;
  const active = pathname === "/account" || pathname.startsWith("/account/");

  return (
    <Link
      href="/account"
      aria-label="Account"
      aria-current={active ? "page" : undefined}
      className={`fixed right-4 top-4 z-40 ${active ? "text-[#7F77DD]" : "text-[#6B6963]"}`}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5.5 19.5c1.2-2.8 3.3-4 6.5-4s5.3 1.2 6.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </Link>
  );
}
