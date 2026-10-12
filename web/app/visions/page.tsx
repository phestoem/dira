"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getPendingNudges, getVisions, type Nudge, type Vision, type VisionStatus } from "@/lib/api";

const FILTERS: Array<{ id: "" | VisionStatus; label: string }> = [
  { id: "", label: "All" },
  { id: "seed", label: "Seeds" },
  { id: "forming", label: "Forming" },
  { id: "active", label: "Active" },
  { id: "held", label: "Held" },
];

const STATUS_LABEL: Record<string, string> = {
  seed: "Seed",
  forming: "Forming",
  active: "Active",
  held: "Held",
  released: "Released",
};

export default function VisionsPage() {
  const [status, setStatus] = useState<"" | VisionStatus>("");
  const [visions, setVisions] = useState<Vision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nudge, setNudge] = useState<Nudge | null>(null);
  const [nudgeHidden, setNudgeHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getVisions(status)
      .then((page) => {
        if (!cancelled) setVisions(page.visions);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load visions.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    getPendingNudges()
      .then((page) => {
        if (!cancelled && page.nudges[0]) setNudge(page.nudges[0]);
      })
      .catch(() => {
        /* A missing nudge should not block the list. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-[100dvh]">
      <main className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="text-[15px] text-[#F5F3EE]">Visions</h1>
        <p className="mt-1 text-sm text-[#6B6963]">Things you&apos;re building toward</p>

        {nudge && !nudgeHidden ? (
          <div
            className="mt-6 rounded-lg border border-[#3C3489] bg-[#1A1A2E] px-4 py-3"
            style={{ borderWidth: "0.5px" }}
          >
            <p className="text-sm leading-relaxed text-[#F5F3EE]">{nudge.nudgeMessage}</p>
            <div className="mt-3 flex gap-4 text-xs">
              <Link href={`/visions/${nudge.visionId}`} className="text-[#7F77DD]">
                Tell me more
              </Link>
              <button type="button" onClick={() => setNudgeHidden(true)} className="text-[#6B6963]">
                Not yet
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-8 flex flex-wrap gap-2">
          {FILTERS.map((item) => (
            <button
              key={item.id || "all"}
              type="button"
              onClick={() => setStatus(item.id)}
              className={`rounded-full px-3 py-1 text-sm ${
                status === item.id
                  ? "bg-[#3C3489] text-[#F5F3EE]"
                  : "border border-[#2A2A28] text-[#6B6963]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {error ? <p className="mt-6 text-sm text-red-300/85">{error}</p> : null}
        {loading && visions.length === 0 ? <p className="mt-8 text-sm text-[#6B6963]">Loading…</p> : null}
        {!loading && !error && visions.length === 0 ? (
          <p className="mt-8 max-w-sm text-sm leading-relaxed text-[#6B6963]">
            Your visions will appear here as you write. Start in your{" "}
            <Link href="/journal" className="text-[#F5F3EE] underline-offset-4 hover:underline">
              journal
            </Link>{" "}
            — DIRA listens.
          </p>
        ) : null}

        <ul className="mt-6 space-y-3">
          {visions.map((vision) => (
            <li key={vision.id} className="rounded-lg border border-[#2A2A28] px-4 py-4">
              <div className="flex items-start justify-between gap-4">
                <h2 className="text-lg text-[#F5F3EE]">
                  <Link href={`/visions/${vision.id}`} className="hover:underline">
                    {vision.title}
                  </Link>
                </h2>
                <span className="shrink-0 rounded-full border border-[#2A2A28] px-2 py-0.5 text-xs text-[#6B6963]">
                  {STATUS_LABEL[vision.status] ?? vision.status}
                </span>
              </div>
              {vision.summary ? (
                <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-[#F5F3EE]/80">{vision.summary}</p>
              ) : null}
              {vision.tags.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {vision.tags.map((tag) => (
                    <span key={tag} className="rounded-full bg-[#161614] px-2 py-0.5 text-[11px] text-[#6B6963]">
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#6B6963]">
                {vision.location ? <span>{vision.location}</span> : null}
                <span>{formatWhen(vision.lastTouchedAt)}</span>
                {vision.detectedFromJournal ? <span>Detected from journal</span> : null}
              </div>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}

function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
