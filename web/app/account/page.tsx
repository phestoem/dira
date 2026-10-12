"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { logout } from "@/lib/api";
import { clearTokens, getUser, type StoredUser } from "@/lib/auth";

export default function AccountPage() {
  const router = useRouter();
  const [user, setUser] = useState<StoredUser | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    setUser(getUser());
  }, []);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
    } catch {
      /* Local session is cleared either way. */
    }
    clearTokens();
    router.replace("/login");
  }

  const memberSince = user?.createdAt ? formatDate(user.createdAt) : "";

  return (
    <main className="mx-auto min-h-[100dvh] w-full max-w-lg px-6 pt-12">
      <h1 className="text-[15px] text-[#F5F3EE]">Account</h1>

      <div className="mt-10 space-y-6">
        <div>
          <p className="text-[17px] text-[#F5F3EE]">{user?.name || "—"}</p>
          <p className="mt-1 text-sm text-[#6B6963]">{user?.handle ? `@${user.handle}` : ""}</p>
        </div>
        <p className="text-sm text-[#F5F3EE]/90">{user?.email || ""}</p>
        <p className="text-sm text-[#6B6963]">
          {memberSince ? `Member since ${memberSince}` : "Member since"}
        </p>
      </div>

      <div className="my-10 h-px bg-[#2A2A28]" />

      <button
        type="button"
        onClick={() => void signOut()}
        disabled={signingOut}
        className="w-full border border-[#2A2A28] py-3 text-sm text-[#6B6963] disabled:opacity-60"
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </main>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
