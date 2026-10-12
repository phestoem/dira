"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getMe, linkAltimetrix, logout, syncAltimetrix } from "@/lib/api";
import { clearTokens, getUser, saveUser, type StoredUser } from "@/lib/auth";

export default function AccountPage() {
  const router = useRouter();
  const [user, setUser] = useState<StoredUser | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [altimetrixUserId, setAltimetrixUserId] = useState<string | null>(null);
  const [linkId, setLinkId] = useState("");
  const [linking, setLinking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [bridgeNote, setBridgeNote] = useState<string | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  useEffect(() => {
    setUser(getUser());
    let cancelled = false;
    getMe()
      .then((me) => {
        if (cancelled) return;
        setAltimetrixUserId(me.altimetrixUserId || null);
        saveUser(me);
      })
      .catch(() => {
        if (!cancelled) setAltimetrixUserId(null);
      });
    return () => {
      cancelled = true;
    };
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

  async function link() {
    const value = linkId.trim();
    if (!value || linking) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      setBridgeError("Enter the Altimetrix user id.");
      return;
    }
    setLinking(true);
    setBridgeError(null);
    setBridgeNote(null);
    try {
      const me = await linkAltimetrix(value);
      setAltimetrixUserId(me.altimetrixUserId || value);
      saveUser({ ...(getUser() || {}), ...me });
      setLinkId("");
      setBridgeNote("Linked. Pending events are on their way.");
    } catch (err) {
      setBridgeError(err instanceof Error ? err.message : "Could not link Altimetrix.");
    } finally {
      setLinking(false);
    }
  }

  async function sendPending() {
    if (syncing) return;
    setSyncing(true);
    setBridgeError(null);
    try {
      const result = await syncAltimetrix();
      setBridgeNote(result.sent > 0 ? `Sent ${result.sent} events.` : "Nothing new to send.");
    } catch (err) {
      setBridgeError(err instanceof Error ? err.message : "Could not send events.");
    } finally {
      setSyncing(false);
    }
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

      <section>
        <h2 className="text-sm text-[#F5F3EE]">Connected systems</h2>
        {altimetrixUserId ? (
          <div className="mt-4">
            <p className="text-sm text-[#6B6963]">✓ Altimetrix connected</p>
            <button
              type="button"
              onClick={() => void sendPending()}
              disabled={syncing}
              className="mt-4 text-sm text-[#F5F3EE] disabled:opacity-60"
            >
              {syncing ? "Sending…" : "Send pending events"}
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <p className="text-sm text-[#6B6963]">Altimetrix is not connected</p>
            <input
              value={linkId}
              onChange={(event) => setLinkId(event.target.value)}
              placeholder="Altimetrix user id"
              className="mt-4 w-full border-x-0 border-t-0 border-b border-[#2A2A28] bg-transparent pb-2 text-sm text-[#F5F3EE] outline-none placeholder:text-[#6B6963]"
            />
            <button
              type="button"
              onClick={() => void link()}
              disabled={linking || !linkId.trim()}
              className="mt-4 text-sm text-[#F5F3EE] disabled:text-[#6B6963]"
            >
              {linking ? "Linking…" : "Link"}
            </button>
          </div>
        )}
        {bridgeNote ? <p className="mt-4 text-sm text-[#6B6963]">{bridgeNote}</p> : null}
        {bridgeError ? <p className="mt-4 text-sm text-red-300/85">{bridgeError}</p> : null}
      </section>

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
