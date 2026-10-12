"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { getAltimetrixNudge, getVisions, listJournal, saveJournal, type JournalEntry } from "@/lib/api";

export default function JournalPage() {
  const composer = useRef<HTMLTextAreaElement>(null);
  const [content, setContent] = useState("");
  const [when, setWhen] = useState(toDatetimeLocal(new Date()));
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "saved" } | { kind: "vision"; id: string; title: string } | null>(
    null,
  );
  const [nudge, setNudge] = useState<{ message: string; href: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    listJournal()
      .then((page) => {
        if (!cancelled) setEntries(page.entries);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not open the journal.");
      });
    getAltimetrixNudge()
      .then((page) => {
        if (!cancelled && page.nudge) setNudge(page.nudge);
      })
      .catch(() => {
        /* Journal still opens when Altimetrix has nothing to add. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    const text = content.trim();
    if (!text || saving) return;
    setSaving(true);
    setError(null);
    const started = Date.now();
    try {
      const entry = await saveJournal(text, new Date(when).toISOString());
      setEntries((current) => [entry, ...current].sort(byNewest));
      setContent("");
      setWhen(toDatetimeLocal(new Date()));
      setNotice({ kind: "saved" });
      const look = () => {
        getVisions()
          .then((page) => {
            const fresh = page.visions.find((vision) => new Date(vision.lastTouchedAt).getTime() >= started - 1000);
            if (fresh) setNotice({ kind: "vision", id: fresh.id, title: fresh.title });
          })
          .catch(() => {
            /* Saved still stands if the vision check cannot run. */
          });
      };
      window.setTimeout(look, 2000);
      window.setTimeout(look, 6000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-[100dvh]">
      <header className="flex items-center justify-between px-6 py-5">
        <p className="text-sm text-[#F5F3EE]">Journal</p>
        <button
          type="button"
          onClick={() => composer.current?.focus()}
          className="text-lg text-[#6B6963]"
          aria-label="New entry"
        >
          +
        </button>
      </header>

      <main className="mx-auto max-w-xl px-6 pb-16">
        {nudge ? (
          <div className="mb-8 border-l-2 border-[#3C3489] bg-[#1A1A2E] px-4 py-3">
            <p className="text-xs text-[#7F77DD]">Altimetrix is thinking about...</p>
            <p className="mt-2 text-[13px] italic leading-relaxed text-[#F5F3EE]/80">{nudge.message}</p>
            <a
              href={nudge.href}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block text-xs text-[#F5F3EE]"
            >
              Explore this
            </a>
          </div>
        ) : null}
        <textarea
          ref={composer}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="What's on your mind..."
          className="min-h-40 w-full resize-y bg-transparent text-[17px] leading-relaxed text-[#F5F3EE] outline-none placeholder:text-[#6B6963]"
        />
        <div className="mt-2 flex items-center justify-between">
          <input
            type="datetime-local"
            value={when}
            onChange={(event) => setWhen(event.target.value)}
            className="bg-transparent text-xs text-[#6B6963] outline-none [color-scheme:dark]"
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !content.trim()}
            className="text-sm text-[#6B6963] disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        {error ? <p className="mt-4 text-sm text-red-300/85">{error}</p> : null}
        {notice?.kind === "saved" ? <p className="mt-4 text-sm text-[#6B6963]">Saved ✓</p> : null}
        {notice?.kind === "vision" ? (
          <p className="mt-4 text-sm text-[#6B6963]">
            <Link href={`/visions/${notice.id}`} className="text-[#F5F3EE] hover:underline">
              Vision detected — see Visions
            </Link>
          </p>
        ) : null}

        <ul className="mt-12">
          {entries.map((entry) => (
            <li key={entry.id} className="border-t border-[#2A2A28] py-6">
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-[#F5F3EE]/90">
                {entry.content}
              </p>
              <p className="mt-3 text-xs text-[#6B6963]">{formatWhen(entry.occurredAt)}</p>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}

function byNewest(a: JournalEntry, b: JournalEntry) {
  return new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
}

function toDatetimeLocal(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
