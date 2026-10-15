"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getMe, linkAltimetrix, logout, syncAltimetrix, updateDigestSettings } from "@/lib/api";
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
  const [digestEnabled, setDigestEnabled] = useState(true);
  const [digestTime, setDigestTime] = useState("07:00");
  const [digestSaving, setDigestSaving] = useState(false);
  const [digestNote, setDigestNote] = useState<string | null>(null);

  useEffect(() => {
    setUser(getUser());
    let cancelled = false;
    getMe()
      .then((me) => {
        if (cancelled) return;
        setAltimetrixUserId(me.altimetrixUserId || null);
        setDigestEnabled(me.settings?.digestEnabled !== false);
        setDigestTime(me.settings?.digestTime || "07:00");
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

  async function saveDigest(enabled: boolean, time: string) {
    setDigestEnabled(enabled);
    setDigestTime(time);
    setDigestSaving(true);
    setDigestNote(null);
    try {
      const me = await updateDigestSettings({ digestEnabled: enabled, digestTime: time });
      setDigestEnabled(me.settings?.digestEnabled !== false);
      setDigestTime(me.settings?.digestTime || time);
    } catch (err) {
      setDigestNote(err instanceof Error ? err.message : "Could not save the morning digest.");
    } finally {
      setDigestSaving(false);
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

      <section>
        <h2 className="text-sm text-[#F5F3EE]">Morning digest</h2>
        <div className="mt-4 flex items-center justify-between gap-4">
          <p className="text-sm text-[#6B6963]">Email a short brief of what is coming up.</p>
          <button
            type="button"
            role="switch"
            aria-checked={digestEnabled}
            aria-label="Morning digest"
            disabled={digestSaving}
            onClick={() => void saveDigest(!digestEnabled, digestTime)}
            className={`relative h-6 w-11 shrink-0 rounded-full border border-[#2A2A28] disabled:opacity-60 ${digestEnabled ? "bg-[#3C3489]" : "bg-[#161614]"}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-[#F5F3EE] transition-all ${digestEnabled ? "left-6" : "left-0.5"}`} />
          </button>
        </div>
        <label className="mt-4 flex items-center justify-between gap-4 text-sm text-[#6B6963]">
          Time
          <input
            type="time"
            value={digestTime}
            disabled={digestSaving || !digestEnabled}
            onChange={(event) => void saveDigest(digestEnabled, event.target.value || "07:00")}
            className="bg-transparent text-sm text-[#F5F3EE] disabled:opacity-40"
            style={{ colorScheme: "dark" }}
          />
        </label>
        <p className="mt-3 text-xs text-[#6B6963]">Helsinki time. Default is 7:00.</p>
        {digestNote ? <p className="mt-3 text-sm text-red-300/85">{digestNote}</p> : null}
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
