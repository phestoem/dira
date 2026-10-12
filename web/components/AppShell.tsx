"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

const QUIET = new Set(["/home", "/library", "/account", "/advisor", "/login"]);

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const pad = pathname === "/login" ? "" : QUIET.has(pathname) ? "pb-14" : "pb-28";
  return <div className={pad}>{children}</div>;
}
